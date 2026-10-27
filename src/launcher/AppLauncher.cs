using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("OBS Google Sheet Importer GUI")]
[assembly: AssemblyDescription("Live OBS Google Sheet Importer Desktop GUI with Tray Controls")]
[assembly: AssemblyCompany("MisterBantastic")]
[assembly: AssemblyProduct("OBS Google Sheet Importer GUI")]
[assembly: AssemblyCopyright("Copyright © 2026 MisterBantastic")]
[assembly: AssemblyFileVersion("0.2.0.0")]
[assembly: AssemblyVersion("0.2.0.0")]

namespace SheetsToOBS
{
    class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Only one launcher per user session. A second launch just opens another
            // window on the running server instead of starting a second server
            // (which used to crash with EADDRINUSE).
            bool isFirstInstance;
            using (Mutex instanceMutex = new Mutex(true, "Local\\SheetsToOBS_Launcher", out isFirstInstance))
            {
                if (!isFirstInstance)
                {
                    TrayAppContext.OpenGuiWindow(AppDomain.CurrentDomain.BaseDirectory);
                    return;
                }
                RunTray();
            }
        }

        private static void RunTray()
        {
            TrayAppContext context = null;
            try
            {
                context = new TrayAppContext();
                Application.Run(context);
            }
            catch (Exception ex)
            {
                WriteLauncherCrashLog(AppDomain.CurrentDomain.BaseDirectory, "LAUNCHER_FATAL_ERROR", ex.ToString());
                MessageBox.Show(
                    "SheetsToOBS Launcher encountered an error:\n\n" + ex.Message,
                    "SheetsToOBS Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                if (context != null)
                {
                    context.Dispose();
                }
            }
        }

        /// <summary>
        /// Folder the server writes to (must match src/paths.js): the app folder in
        /// portable mode (config.json or portable.txt next to the app), otherwise
        /// %APPDATA%\SheetsToOBS.
        /// </summary>
        public static string DataDir(string baseDir)
        {
            string custom = Environment.GetEnvironmentVariable("SHEETSTOOBS_DATA_DIR");
            if (!string.IsNullOrEmpty(custom)) return custom;
            bool portable = File.Exists(Path.Combine(baseDir, "config.json")) || File.Exists(Path.Combine(baseDir, "portable.txt"));
            if (portable && CanWrite(baseDir)) return baseDir;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SheetsToOBS");
        }

        private static bool CanWrite(string dir)
        {
            try
            {
                string probe = Path.Combine(dir, ".write-test-launcher");
                File.WriteAllText(probe, "");
                File.Delete(probe);
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static void WriteLauncherCrashLog(string baseDir, string type, string details)
        {
            try
            {
                string logsDir = Path.Combine(DataDir(baseDir), "logs");
                if (!Directory.Exists(logsDir)) Directory.CreateDirectory(logsDir);

                string crashFile = Path.Combine(logsDir, "crash.log");
                string report = 
                    "======================================================================\r\n" +
                    "SHEETSTOOBS LAUNCHER CRASH REPORT - " + DateTime.UtcNow.ToString("o") + "\r\n" +
                    "======================================================================\r\n" +
                    "Crash Type:      " + type + "\r\n" +
                    "OS Version:      " + Environment.OSVersion.ToString() + " (" + (Environment.Is64BitOperatingSystem ? "64-bit" : "32-bit") + ")\r\n" +
                    "User Name:       " + Environment.UserName + "\r\n" +
                    "Working Dir:     " + baseDir + "\r\n" +
                    "----------------------------------------------------------------------\r\n" +
                    "DETAILS:\r\n" +
                    details + "\r\n" +
                    "======================================================================\r\n\r\n";

                File.AppendAllText(crashFile, report);
            }
            catch
            {
            }
        }
    }

    public class TrayAppContext : ApplicationContext
    {
        private NotifyIcon notifyIcon;
        private ContextMenu contextMenu;
        private Process serverProcess;
        private string baseDir;
        private const string TargetUrl = "http://localhost:4587";
        private bool isEngineRunning = false;

        public TrayAppContext()
        {
            baseDir = AppDomain.CurrentDomain.BaseDirectory;

            // 1. Initialize System Tray Icon
            InitializeTray();

            // 2. Start Background Server Runtime
            StartServerRuntime();

            // 3. Launch UI Window with Saved Position & Size Memory
            LaunchGuiWindow();
        }

        private void InitializeTray()
        {
            contextMenu = new ContextMenu();

            MenuItem itemShow = new MenuItem("🪟 Show Dashboard", (s, e) => LaunchGuiWindow());
            MenuItem itemSyncNow = new MenuItem("⚡ Sync Now", (s, e) => TriggerSyncNow());
            MenuItem itemToggleEngine = new MenuItem("▶ Start Sync Engine", (s, e) => ToggleSyncEngine());
            // The web dashboard / mobile remote is experimental and switched off by
            // default, so it has no tray entry for now (it is opened from the app).
            MenuItem itemSep = new MenuItem("-");
            MenuItem itemExit = new MenuItem("❌ Exit SheetsToOBS", (s, e) => ExitApplication());

            contextMenu.MenuItems.Add(itemShow);
            contextMenu.MenuItems.Add(itemSyncNow);
            contextMenu.MenuItems.Add(itemToggleEngine);
            contextMenu.MenuItems.Add(itemSep);
            contextMenu.MenuItems.Add(itemExit);

            notifyIcon = new NotifyIcon
            {
                Icon = CreateAppIcon(),
                ContextMenu = contextMenu,
                Text = "SheetsToOBS - Live OBS Google Sheet Importer",
                Visible = true
            };

            notifyIcon.DoubleClick += (s, e) => LaunchGuiWindow();

            // Read the real engine state whenever the menu opens, so the Start/Stop
            // label is right even when the engine was started from the app window.
            contextMenu.Popup += (s, e) =>
            {
                bool? running = QueryEngineRunning();
                if (running.HasValue)
                {
                    isEngineRunning = running.Value;
                    UpdateTrayMenu();
                }
            };
        }

        private static bool? QueryEngineRunning()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4587/api/status");
                req.Method = "GET";
                req.Timeout = 1500;
                using (var resp = req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream()))
                {
                    string json = reader.ReadToEnd();
                    Match m = Regex.Match(json, "\"running\"\\s*:\\s*(true|false)");
                    if (m.Success) return m.Groups[1].Value == "true";
                }
            }
            catch { }
            return null;
        }

        private Icon CreateAppIcon()
        {
            try
            {
                string iconPath = Path.Combine(baseDir, "assets", "icon.ico");
                if (File.Exists(iconPath))
                {
                    return new Icon(iconPath);
                }
            }
            catch { }

            // Dynamically draw a stylized emerald sync icon bitmap
            try
            {
                using (Bitmap bmp = new Bitmap(32, 32))
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.FromArgb(10, 13, 20));

                    using (Brush bgBrush = new SolidBrush(Color.FromArgb(18, 24, 36)))
                    {
                        g.FillEllipse(bgBrush, 1, 1, 30, 30);
                    }

                    using (Pen ringPen = new Pen(Color.FromArgb(6, 214, 160), 3f))
                    {
                        g.DrawArc(ringPen, 5, 5, 22, 22, 45, 270);
                    }

                    using (Brush arrowBrush = new SolidBrush(Color.FromArgb(6, 214, 160)))
                    {
                        Point[] arrow = new Point[] {
                            new Point(20, 3),
                            new Point(27, 8),
                            new Point(20, 13)
                        };
                        g.FillPolygon(arrowBrush, arrow);
                    }

                    IntPtr hIcon = bmp.GetHicon();
                    return Icon.FromHandle(hIcon);
                }
            }
            catch
            {
                return SystemIcons.Application;
            }
        }

        private void StartServerRuntime()
        {
            // A server is already running (e.g. started by launch-gui.bat): reuse it.
            if (IsPortOpen("127.0.0.1", 4587)) return;

            string nodeExe = Path.Combine(baseDir, "runtime", "node.exe");
            if (!File.Exists(nodeExe)) nodeExe = Path.Combine(baseDir, "node.exe");
            if (!File.Exists(nodeExe))
            {
                string pfNode = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
                if (File.Exists(pfNode)) nodeExe = pfNode;
                else nodeExe = "node.exe";
            }

            string serverJs = Path.Combine(baseDir, "src", "server.js");
            ProcessStartInfo serverInfo = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + serverJs + "\"",
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            try
            {
                serverProcess = Process.Start(serverInfo);
                if (serverProcess != null)
                {
                    serverProcess.EnableRaisingEvents = true;
                    serverProcess.Exited += (s, e) =>
                    {
                        if (notifyIcon != null)
                        {
                            notifyIcon.Visible = false;
                            notifyIcon.Dispose();
                            notifyIcon = null;
                        }
                        Application.Exit();
                    };
                    serverProcess.BeginErrorReadLine();
                }
            }
            catch (Exception ex)
            {
                Program.WriteLauncherCrashLog(baseDir, "SERVER_SPAWN_ERROR", ex.ToString());
            }

            // Wait for port 4587
            for (int i = 0; i < 30; i++)
            {
                Thread.Sleep(150);
                if (IsPortOpen("127.0.0.1", 4587)) break;
            }
        }

        private void LaunchGuiWindow()
        {
            OpenGuiWindow(baseDir);
        }

        public static void OpenGuiWindow(string baseDir)
        {
            try
            {
                // Read window-state.json for position & size memory
                int width = 580;
                int height = 680;
                int? posX = null;
                int? posY = null;

                string statePath = Path.Combine(Program.DataDir(baseDir), "window-state.json");
                if (File.Exists(statePath))
                {
                    try
                    {
                        string json = File.ReadAllText(statePath);
                        Match mW = Regex.Match(json, "\"width\":\\s*(\\d+)");
                        Match mH = Regex.Match(json, "\"height\":\\s*(\\d+)");
                        // x/y may be negative on a monitor left of / above the main one.
                        Match mX = Regex.Match(json, "\"x\":\\s*(-?\\d+)");
                        Match mY = Regex.Match(json, "\"y\":\\s*(-?\\d+)");

                        if (mW.Success) width = Math.Max(380, int.Parse(mW.Groups[1].Value));
                        if (mH.Success) height = Math.Max(480, int.Parse(mH.Groups[1].Value));
                        if (mX.Success) posX = int.Parse(mX.Groups[1].Value);
                        if (mY.Success) posY = int.Parse(mY.Groups[1].Value);
                    }
                    catch { }
                }

                string edge86 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe");
                string edge64 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe");
                string chrome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe");
                string chrome86 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe");

                string args = "--app=" + TargetUrl + " --window-size=" + width + "," + height;
                if (posX.HasValue && posY.HasValue)
                {
                    args += " --window-position=" + posX + "," + posY;
                }

                if (File.Exists(edge86)) Process.Start(edge86, args);
                else if (File.Exists(edge64)) Process.Start(edge64, args);
                else if (File.Exists(chrome)) Process.Start(chrome, args);
                else if (File.Exists(chrome86)) Process.Start(chrome86, args);
                else Process.Start(TargetUrl);
            }
            catch (Exception ex)
            {
                Program.WriteLauncherCrashLog(baseDir, "GUI_LAUNCH_ERROR", ex.ToString());
            }
        }

        private void TriggerSyncNow()
        {
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4587/api/control/sync-now");
                    req.Method = "POST";
                    req.ContentLength = 0;
                    req.Timeout = 3000;
                    using (var resp = req.GetResponse()) { }

                    if (notifyIcon != null)
                    {
                        notifyIcon.ShowBalloonTip(1500, "SheetsToOBS", "⚡ Immediate Sync Triggered", ToolTipIcon.Info);
                    }
                }
                catch (Exception ex)
                {
                    if (notifyIcon != null)
                    {
                        notifyIcon.ShowBalloonTip(2000, "SheetsToOBS Error", "Sync failed: " + ex.Message, ToolTipIcon.Warning);
                    }
                }
            });
        }

        private void ToggleSyncEngine()
        {
            ThreadPool.QueueUserWorkItem((state) =>
            {
                try
                {
                    bool? running = QueryEngineRunning();
                    if (running.HasValue) isEngineRunning = running.Value;
                    string endpoint = isEngineRunning ? "/api/control/stop" : "/api/control/start";
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4587" + endpoint);
                    req.Method = "POST";
                    req.ContentLength = 0;
                    req.Timeout = 3000;
                    using (var resp = req.GetResponse()) { }

                    isEngineRunning = !isEngineRunning;
                    UpdateTrayMenu();

                    if (notifyIcon != null)
                    {
                        notifyIcon.ShowBalloonTip(1500, "SheetsToOBS", isEngineRunning ? "▶ Sync Engine Started" : "⏸ Sync Engine Stopped", ToolTipIcon.Info);
                    }
                }
                catch { }
            });
        }

        private void UpdateTrayMenu()
        {
            if (contextMenu != null && contextMenu.MenuItems.Count > 2)
            {
                contextMenu.MenuItems[2].Text = isEngineRunning ? "⏸ Stop Sync Engine" : "▶ Start Sync Engine";
            }
        }

        private void ExitApplication()
        {
            try
            {
                // Send clean shutdown to server
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:4587/api/shutdown");
                    req.Method = "POST";
                    req.ContentLength = 0;
                    req.Timeout = 800;
                    using (var resp = req.GetResponse()) { }
                }
                catch { }

                if (notifyIcon != null)
                {
                    notifyIcon.Visible = false;
                    notifyIcon.Dispose();
                    notifyIcon = null;
                }

                if (serverProcess != null && !serverProcess.HasExited)
                {
                    try { serverProcess.Kill(); } catch { }
                }
            }
            catch { }
            finally
            {
                Application.Exit();
            }
        }

        private static bool IsPortOpen(string host, int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    var result = client.BeginConnect(host, port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(200);
                    if (success && client.Connected)
                    {
                        client.EndConnect(result);
                        return true;
                    }
                }
            }
            catch { }
            return false;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (notifyIcon != null)
                {
                    notifyIcon.Visible = false;
                    notifyIcon.Dispose();
                    notifyIcon = null;
                }
            }
            base.Dispose(disposing);
        }
    }
}
