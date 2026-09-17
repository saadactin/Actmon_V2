// Installs the extensionless-import resolve hook. A file rather than an inline
// `--import data:...` URL because PowerShell re-quotes the inline form and node
// then reads it as a package name.
import { register } from 'node:module';

register('./ext-loader.mjs', import.meta.url);
