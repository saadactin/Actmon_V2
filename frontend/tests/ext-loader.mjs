// Vite resolves extensionless relative imports; node does not. The codebase
// writes `from './costFormat'`, so this hook retries with .js rather than
// making the source carry extensions it does not need.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js')) {
      return next(`${specifier}.js`, context);
    }
    throw err;
  }
}
