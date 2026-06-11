import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Terminal } from 'lucide-react';

export default function ServerDetail() {
  const { serverId } = useParams();
  const navigate = useNavigate();

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [lines, setLines] = useState([
    `root@server-${serverId}:~# hostname`,
    `server-${serverId}`,
  ]);
  const [command, setCommand] = useState('');

  const runCommand = (e) => {
    if (e.key !== 'Enter') return;
    const cmd = command.trim();
    if (!cmd) return;
    setLines((l) => [...l, `root@server-${serverId}:~# ${cmd}`, `Command '${cmd}' executed (simulated)`]);
    setCommand('');
  };

  return (
    <div className="min-h-screen bg-[#f5f7fb] p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl border bg-white flex items-center justify-center">Back</button>
          <div>
            <h1 className="text-3xl font-bold">Server {serverId}</h1>
            <p className="text-slate-500 mt-1">OS server details and simple terminal (simulated).</p>
          </div>
        </div>

        <div className="bg-white rounded-2xl border p-6 mb-6">
          <p className="text-slate-600">ID: <strong>{serverId}</strong></p>
          <p className="text-slate-600">Name: <strong>Server {serverId}</strong></p>
          <p className="text-slate-600">IP: <strong>192.168.1.{Number(serverId) % 255}</strong></p>
          <div className="mt-4 flex gap-3">
            <button onClick={() => setTerminalOpen(true)} className="px-4 py-2 rounded-xl bg-slate-900 text-white">Open Terminal</button>
            <button onClick={() => navigate('/databases')} className="px-4 py-2 rounded-xl border">Back to Servers</button>
          </div>
        </div>

        {terminalOpen && (
          <div className="bg-black text-green-400 font-mono p-4 rounded-md"> 
            <div className="space-y-2 mb-3">
              {lines.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap">{line}</div>
              ))}
            </div>
            <input value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={runCommand} className="w-full bg-black outline-none text-green-400" placeholder="type command and press Enter" />
            <div className="mt-3 text-right">
              <button onClick={() => setTerminalOpen(false)} className="px-3 py-1 rounded border">Close</button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
