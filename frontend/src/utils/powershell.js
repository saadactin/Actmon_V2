// PowerShell's -EncodedCommand expects base64 of the script text encoded as
// UTF-16LE (its native "Unicode" string encoding) — not plain UTF-8 base64.
// Use this whenever a generated one-liner needs to run a script inside
// ANOTHER PowerShell process (e.g. `Start-Process powershell -Verb RunAs`):
// wrapping the inner script in a quoted -Command argument doesn't defer
// evaluation the way it looks like it should — a user pasting the whole
// one-liner into an already-open PowerShell prompt has THAT prompt's parser
// interpolate any `$variable` in a double-quoted string immediately, before
// the elevated child process ever sees it. -EncodedCommand's payload is
// base64 (alphanumeric + `/+=` only), which contains none of PowerShell's
// special characters, so it can never be touched by whatever shell is
// currently parsing the outer line.
export function toPowerShellEncodedCommand(script) {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
