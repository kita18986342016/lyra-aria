// core/sync-bundle.js — 双端同步数据格式 v3（CommonJS 版，与移动端 web/js/sync.js 对齐）
// 只同步"引用"（source/ref），不同步音频/本地文件。
// v3：每条带 updatedAt；删除/取消收藏/解绑记为墓碑(tombstone) 可传播；合并=逐条 updatedAt 取新 + 墓碑删除。
'use strict';

const SYNC_FORMAT = 'lyra-sync-v3';
const ACCEPTED = { 'lyra-sync-v1': 1, 'lyra-sync-v2': 1, 'lyra-sync-v3': 1 };
function now() { return Date.now(); }

function songRef(song) {
  if (!song || !song.online) return null;
  return { source: song.source, ref: song.ref, title: song.title || '', artist: song.artist || '', album: song.album || '', duration: song.duration || 0, picUrl: song.picUrl || '' };
}

function exportBundle({ onlinePlaylists = [], favorites = [], recent = [], profile = null, accounts = null, tombstones = null } = {}, device = 'pc') {
  const pls = [];
  for (const pl of onlinePlaylists) {
    const songs = (pl.songs || []).map(songRef).filter(Boolean);
    if (songs.length) pls.push({ id: pl.id, name: pl.name || '在线歌单', source: pl.source || '', cover: pl.cover || '', songs, updatedAt: pl.updatedAt || pl.createdAt || now() });
  }
  const favs = [];
  for (const f of favorites) { const r = songRef(f); if (r) favs.push(Object.assign(r, { updatedAt: f.updatedAt || now() })); }
  const recents = recent.filter((x) => x && x.online && x.ref).map((x) => ({ source: x.source, ref: x.ref, at: x.at || 0 }));
  return { format: SYNC_FORMAT, exportedAt: now(), device, onlinePlaylists: pls, favorites: favs, recent: recents, profile: profile || null, accounts: accounts || null, tombstones: Array.isArray(tombstones) ? tombstones : [] };
}

function importBundle(bundle) {
  if (!bundle || !ACCEPTED[bundle.format]) return { ok: false, reason: '不是有效的同步包（格式不符）' };
  const out = { ok: true, onlinePlaylists: [], favorites: [], recent: [], profile: bundle.profile || null, accounts: bundle.accounts || null, tombstones: Array.isArray(bundle.tombstones) ? bundle.tombstones : [], skippedLocal: 0 };
  const seenPl = new Set();
  for (const pl of Array.isArray(bundle.onlinePlaylists) ? bundle.onlinePlaylists : []) {
    if (!pl || !pl.id || seenPl.has(pl.id)) continue;
    const songs = (pl.songs || []).filter((s) => s && s.source && s.ref).map((s) => ({
      id: 'online:' + s.source + ':' + s.ref, online: true, source: s.source, ref: s.ref,
      title: s.title || '', artist: s.artist || '', album: s.album || '', duration: s.duration || 0, picUrl: s.picUrl || '',
      level: (s.source === 'netease') ? 'lossless' : (s.source === 'kugou' ? '128' : 'lossless')
    }));
    if (!songs.length) continue;
    seenPl.add(pl.id);
    out.onlinePlaylists.push({ id: pl.id, name: pl.name || '在线歌单', source: pl.source || '', cover: pl.cover || '', songs, updatedAt: pl.updatedAt || now() });
  }
  for (const f of Array.isArray(bundle.favorites) ? bundle.favorites : []) {
    if (f && f.source && f.ref) out.favorites.push({ id: 'online:' + f.source + ':' + f.ref, online: true, source: f.source, ref: f.ref, title: f.title || '', artist: f.artist || '', album: f.album || '', duration: f.duration || 0, picUrl: f.picUrl || '', updatedAt: f.updatedAt || now() });
  }
  for (const r of Array.isArray(bundle.recent) ? bundle.recent : []) {
    if (r && r.source && r.ref) out.recent.push({ id: 'online:' + r.source + ':' + r.ref, online: true, source: r.source, ref: r.ref, at: r.at || 0 });
  }
  return out;
}

function favKey(x) { return x.source + ':' + x.ref; }

function mergeBundles(a, b) {
  const A = a && typeof a === 'object' ? a : {};
  const B = b && typeof b === 'object' ? b : {};
  const tsA = A.exportedAt || 0, tsB = B.exportedAt || 0;
  const tomMap = new Map();
  for (const t of (A.tombstones || [])) if (t && t.key) tomMap.set(t.key, t.at || 0);
  for (const t of (B.tombstones || [])) if (t && t.key) { const ex = tomMap.get(t.key) || 0; if ((t.at || 0) > ex) tomMap.set(t.key, t.at || 0); }
  const tomAt = (k) => tomMap.get(k) || 0;
  const tomActive = (k, updatedAt) => tomAt(k) > (updatedAt || 0);
  const plMap = new Map();
  for (const p of (A.onlinePlaylists || [])) if (p && p.id) plMap.set(p.id, p);
  for (const p of (B.onlinePlaylists || [])) { if (!p || !p.id) continue; const ex = plMap.get(p.id); if (!ex || (p.updatedAt || 0) >= (ex.updatedAt || 0)) plMap.set(p.id, p); }
  for (const [id, p] of [...plMap]) { if (tomActive('pl:' + id, p.updatedAt)) plMap.delete(id); }
  const favMap = new Map();
  for (const f of (A.favorites || [])) if (f && f.source && f.ref) favMap.set(favKey(f), f);
  for (const f of (B.favorites || [])) { if (!f || !f.source || !f.ref) continue; const k = favKey(f); const ex = favMap.get(k); if (!ex) favMap.set(k, f); else if ((f.updatedAt || 0) >= (ex.updatedAt || 0) || (f.picUrl && !ex.picUrl)) favMap.set(k, Object.assign({}, ex, f, { picUrl: f.picUrl || ex.picUrl, title: ex.title || f.title, artist: ex.artist || f.artist })); }
  for (const [k, f] of [...favMap]) { if (tomActive('fav:' + k, f.updatedAt)) favMap.delete(k); }
  const recMap = new Map();
  for (const r of (A.recent || [])) if (r && r.source && r.ref) recMap.set(favKey(r), r);
  for (const r of (B.recent || [])) { if (!r || !r.source || !r.ref) continue; const k = favKey(r); const ex = recMap.get(k); if (!ex || (r.at || 0) > (ex.at || 0)) recMap.set(k, r); }
  const pa = A.profile || {}, pb = B.profile || {};
  const pick = (field) => { const va = pa[field], vb = pb[field]; if (!va) return vb || ''; if (!vb) return va; return (pb.updatedAt || tsB) >= (pa.updatedAt || tsA) ? vb : va; };
  const profile = (pa.nickname || pa.avatar || pb.nickname || pb.avatar) ? { nickname: pick('nickname'), avatar: pick('avatar'), updatedAt: Math.max(pa.updatedAt || 0, pb.updatedAt || 0) } : null;
  const acctA = A.accounts || {}, acctB = B.accounts || {};
  const filled = (x) => !!(x && (x.cookie || x.token || x.mid));
  const accounts = {};
  for (const src of ['netease', 'kugou', 'bilibili']) {
    const x = acctA[src], y = acctB[src];
    let chosen = null;
    if (filled(y) && (!filled(x) || tsB >= tsA)) chosen = y; else if (filled(x)) chosen = x; else chosen = y || x || null;
    if (chosen && tomActive('acc:' + src, chosen.updatedAt || 0)) chosen = null;
    accounts[src] = chosen;
  }
  return {
    format: SYNC_FORMAT, exportedAt: now(), device: 'merged',
    onlinePlaylists: [...plMap.values()], favorites: [...favMap.values()],
    recent: [...recMap.values()].sort((x, y) => (y.at || 0) - (x.at || 0)),
    profile, accounts,
    tombstones: [...tomMap].map(([key, at]) => ({ key, at }))
  };
}

module.exports = { SYNC_FORMAT, exportBundle, importBundle, mergeBundles };
