Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class T {
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h,uint msg,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb f,IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out R r);
  delegate bool Cb(IntPtr h,IntPtr l);
  public struct R{public int L,T2,Rt,B;}
  static uint[] _p;
  // first visible big window (main window; lyric window is small, hidden windows have 0-size rect)
  public static IntPtr FindMainVisible(uint[] pids){_p=pids;IntPtr found=IntPtr.Zero;EnumWindows((h,l)=>{if(found!=IntPtr.Zero)return true;uint pp;GetWindowThreadProcessId(h,out pp);bool mine=false;foreach(var x in _p)if(x==pp)mine=true;if(!mine)return true;var r=new R();GetWindowRect(h,out r);int w=r.Rt-r.L,ht=r.B-r.T2;if(IsWindowVisible(h)&&w>500&&ht>400){found=h;}return true;},IntPtr.Zero);return found;}
  public static bool Vis(IntPtr h){return h!=IntPtr.Zero && IsWindowVisible(h);}
  public static void Close(IntPtr h){PostMessageW(h,0x10,IntPtr.Zero,IntPtr.Zero);}
}
'@
$exe = (Get-Item 'D:\MusicPlayer\lyra-aria\*.exe' | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1).FullName
function Get-AppPids { @(Get-Process | Where-Object { try { $_.Path -like 'D:\MusicPlayer\lyra-aria\*' } catch { $false } } | ForEach-Object { [uint32]$_.Id }) }
Get-Process | Where-Object { try { $_.Path -like 'D:\MusicPlayer\lyra-aria\*' -or $_.Path -like 'D:\MusicPlayer\node_modules\electron\*' } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2
Start-Process $exe
Start-Sleep -Seconds 12
$pids = Get-AppPids
$hwnd = [T]::FindMainVisible($pids)
Write-Output ("STEP1 started, main hwnd=" + $hwnd + " visible=" + [T]::Vis($hwnd))
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'RESULT: FAIL - no main window at start'; exit 1 }
[T]::Close($hwnd)
Start-Sleep -Seconds 3
Write-Output ("STEP2 after WM_CLOSE, main visible=" + [T]::Vis($hwnd) + " (expect False=tray)")
Start-Process $exe
Start-Sleep -Seconds 6
$pids2 = Get-AppPids
# relaunch may hand over to old instance; re-find by visibility among current pids
$hwnd2 = [T]::FindMainVisible($pids2)
$restored = ($hwnd2 -ne [IntPtr]::Zero)
Write-Output ("STEP3 after relaunch, visible main hwnd=" + $hwnd2)
if ($restored) { Write-Output 'RESULT: PASS - window restored to foreground' } else { Write-Output 'RESULT: FAIL - still hidden' }
