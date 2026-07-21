import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * XTerminal — real interactive PTY terminal via WebSocket.
 *
 * Props:
 *   serverId   {number}  — OS server ID to connect to
 *   serverName {string}  — displayed in placeholder only
 *   height     {string}  — CSS height of the container (default: '100%')
 */
export default function XTerminal({ serverId, serverName, height = '100%' }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const resizeObsRef = useRef(null);

  const cleanup = useCallback(() => {
    try { resizeObsRef.current?.disconnect(); } catch {}
    try { wsRef.current?.close(); } catch {}
    try { termRef.current?.dispose(); } catch {}
    wsRef.current = null;
    termRef.current = null;
    fitAddonRef.current = null;
    resizeObsRef.current = null;
  }, []);

  useEffect(() => {
    if (!containerRef.current || !serverId) return;

    // ── xterm instance ─────────────────────────────────────
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      theme: {
        background:   '#0d1117',
        foreground:   '#c9d1d9',
        cursor:       '#58a6ff',
        black:        '#484f58',
        red:          '#ff7b72',
        green:        '#3fb950',
        yellow:       '#d29922',
        blue:         '#58a6ff',
        magenta:      '#bc8cff',
        cyan:         '#39c5cf',
        white:        '#b1bac4',
        brightBlack:  '#6e7681',
        brightRed:    '#ffa198',
        brightGreen:  '#56d364',
        brightYellow: '#e3b341',
        brightBlue:   '#79c0ff',
        brightMagenta:'#d2a8ff',
        brightCyan:   '#56d4dd',
        brightWhite:  '#f0f6fc',
        selectionBackground: '#264f78',
      },
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, Monaco, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.4,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Fit after a tick so the DOM has laid out
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch {}
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // ── WebSocket connection ────────────────────────────────
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/api/v1/terminal/ws/${serverId}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    term.write('\x1b[90mOpening SSH session…\x1b[0m\r\n');

    ws.onopen = () => {
      // send initial terminal size
      const { cols, rows } = term;
      ws.send(`\x00resize:${cols},${rows}`);
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data));
      } else {
        term.write(e.data);
      }
    };

    ws.onerror = () => {
      term.write('\r\n\x1b[31mWebSocket error — check backend is running.\x1b[0m\r\n');
    };

    ws.onclose = (e) => {
      if (e.code !== 1000) {
        term.write(`\r\n\x1b[90mConnection closed (${e.code})\x1b[0m\r\n`);
      }
    };

    // ── Forward keystrokes → WebSocket ─────────────────────
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // ── Resize handling ────────────────────────────────────
    const sendResize = () => {
      try {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`\x00resize:${term.cols},${term.rows}`);
        }
      } catch {}
    };

    window.addEventListener('resize', sendResize);

    resizeObsRef.current = new ResizeObserver(() => {
      requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
    });
    resizeObsRef.current.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', sendResize);
      cleanup();
    };
  }, [serverId]);

  return (
    <div
      ref={containerRef}
      style={{ height, background: '#0d1117' }}
      className="w-full overflow-hidden"
    />
  );
}
