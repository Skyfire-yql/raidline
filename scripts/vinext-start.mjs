import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function optionValue(...names) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (names.includes(argument)) return args[index + 1];
    for (const name of names) {
      if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    }
  }
  return undefined;
}

const port = Number(optionValue("-p", "--port") ?? process.env.PORT ?? 3000);
const host = optionValue("-H", "--hostname", "--host") ?? process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid port: ${port}`);
}

// vinext 0.0.50 stores StaticFileCache keys with path.relative(). On Windows
// those keys contain backslashes and do not match URL pathnames such as
// /assets/app.css. Keep the workaround at the production boundary and leave
// non-Windows deployments untouched.
if (process.platform === "win32") {
  const { StaticFileCache } = await import("../node_modules/vinext/dist/server/static-file-cache.js");
  const originalLookup = StaticFileCache.prototype.lookup;
  StaticFileCache.prototype.lookup = function lookupWindowsStaticPath(pathname) {
    const direct = originalLookup.call(this, pathname);
    if (direct !== undefined || pathname === "/.vite" || pathname.startsWith("/.vite/")) return direct;
    const windowsPathname = `/${pathname.slice(1).replaceAll("/", "\\")}`;
    return originalLookup.call(this, windowsPathname);
  };
}

const { startProdServer } = await import("../node_modules/vinext/dist/server/prod-server.js");
await startProdServer({
  host,
  port,
  outDir: fileURLToPath(new URL("../dist", import.meta.url)),
});
