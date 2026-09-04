// Native launcher for the fake Claude CLI used by e2e tests, compiled to fake-claude.exe.
//
// Why this exists: ClaudeCliBrain (src/main/brain/claude-cli.ts) spawns config.cliPath
// directly with node's child_process.spawn and no shell option. On Windows, Node refuses
// to spawn a .cmd or .bat file that way (it throws a synchronous EINVAL unless the caller
// passes { shell: true }, a guard added for CVE-2024-27980) and a plain .cjs file is not a
// Windows executable at all, so neither can stand in for the real claude.exe. This tiny
// compiled program is a genuine PE executable, so Node spawns it exactly like it would
// spawn the real CLI, and it just forwards its own argv and stdio to
// `node fake-claude.cjs <argv>` unchanged, then exits with the same code.
//
// Built with the .NET Framework compiler already on Windows (no download, no project
// file): csc.exe /nologo /out:fake-claude.exe fake-claude-launcher.cs
//
// The node executable to run is read from FAKE_CLAUDE_NODE_EXE if set (the e2e spec sets
// it to process.execPath so this does not depend on node being on PATH), otherwise "node".
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class FakeClaudeLauncher
{
    private static int Main(string[] args)
    {
        var here = AppDomain.CurrentDomain.BaseDirectory;
        var script = Path.Combine(here, "fake-claude.cjs");
        var nodeExe = Environment.GetEnvironmentVariable("FAKE_CLAUDE_NODE_EXE");
        if (string.IsNullOrEmpty(nodeExe)) nodeExe = "node";

        var commandLine = new StringBuilder();
        commandLine.Append(EscapeArgument(script));
        foreach (var a in args)
        {
            commandLine.Append(' ');
            commandLine.Append(EscapeArgument(a));
        }

        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = commandLine.ToString(),
            UseShellExecute = false,
        };

        using (var child = Process.Start(psi))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    // The quoting CommandLineToArgvW expects, so the grandchild sees exactly the argv this
    // launcher received: an argument with no space, tab, or quote passes through unchanged;
    // anything else is wrapped in quotes with backslashes doubled only when they immediately
    // precede a quote (either an embedded one or the closing one this method adds).
    private static string EscapeArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return argument;

        var sb = new StringBuilder();
        sb.Append('"');
        for (var i = 0; i < argument.Length;)
        {
            var c = argument[i++];
            if (c == '\\')
            {
                var backslashCount = 1;
                while (i < argument.Length && argument[i] == '\\') { backslashCount++; i++; }
                if (i == argument.Length) sb.Append('\\', backslashCount * 2);
                else if (argument[i] == '"') { sb.Append('\\', backslashCount * 2 + 1); sb.Append('"'); i++; }
                else sb.Append('\\', backslashCount);
            }
            else if (c == '"') { sb.Append('\\'); sb.Append('"'); }
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }
}
