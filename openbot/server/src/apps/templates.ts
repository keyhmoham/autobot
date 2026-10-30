/**
 * What a new app starts as: the few files that make each kind of app run, with a manifest, so a Bot
 * begins from something that installs and opens rather than from an empty directory.
 *
 * Every template serves its files relatively and listens on $PORT at $HOST, the two things an app
 * needs to run behind its link (see apps/links.ts).
 */
import {
  APP_MANIFEST_FILE,
  type AppManifest,
  type AppTemplate,
} from "@openbot/shared/apps";

export type TemplateFile = { path: string; contents: string };

const manifest = (value: AppManifest) => JSON.stringify(value, null, 2);

/** A small Bun server that serves `public/` and answers JSON under `api/`. */
const BUN_SERVER = `// Serves public/ and a JSON API under api/. Listens where the computer says: $HOST:$PORT.
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

const api: Record<string, (request: Request) => Response | Promise<Response>> = {
  "/api/hello": () => Response.json({ message: "Hello from your app." }),
};

Bun.serve({
  port,
  hostname,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const handler = api[pathname];
    if (handler) return handler(request);
    const file = Bun.file(\`public\${pathname === "/" ? "/index.html" : pathname}\`);
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
console.log(\`Listening on \${hostname}:\${port}\`);
`;

const page = (title: string, script: boolean) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p id="message">Edit public/index.html to make this yours.</p>
    </main>
${script ? '    <script type="module" src="./app.js"></script>\n' : ""}  </body>
</html>
`;

const STYLE = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 24px; }
main { max-width: 720px; margin: 0 auto; }
`;

/** The files of a new app named `name`, in `directory`. */
export function templateFiles(
  template: AppTemplate,
  name: string,
  description: string,
  directory: string,
): TemplateFile[] {
  const at = (path: string) => `${directory}/${path}`;
  switch (template) {
    case "static":
      return [
        {
          path: at(APP_MANIFEST_FILE),
          contents: manifest({
            name,
            description,
            icon: "📄",
            start: "bun server.ts",
          }),
        },
        { path: at("server.ts"), contents: BUN_SERVER },
        { path: at("public/index.html"), contents: page(name, false) },
        { path: at("public/style.css"), contents: STYLE },
      ];
    case "bun":
      return [
        {
          path: at(APP_MANIFEST_FILE),
          contents: manifest({
            name,
            description,
            icon: "⚡",
            start: "bun server.ts",
          }),
        },
        { path: at("server.ts"), contents: BUN_SERVER },
        { path: at("public/index.html"), contents: page(name, true) },
        { path: at("public/style.css"), contents: STYLE },
        {
          path: at("public/app.js"),
          // Relative, like every path the app asks for: it is served under its link, not at the root.
          contents: `const answer = await fetch("./api/hello").then((r) => r.json());\ndocument.getElementById("message").textContent = answer.message;\n`,
        },
      ];
    case "vite-react":
      return [
        {
          path: at(APP_MANIFEST_FILE),
          contents: manifest({
            name,
            description,
            icon: "⚛️",
            build: "bun install && bun run build",
            start: "bun server.ts",
          }),
        },
        {
          path: at("package.json"),
          contents: JSON.stringify(
            {
              name: directory.split("/").pop(),
              private: true,
              type: "module",
              scripts: {
                dev: "vite",
                build: "vite build --outDir public --emptyOutDir",
              },
              dependencies: { react: "19.2.0", "react-dom": "19.2.0" },
              devDependencies: {
                "@vitejs/plugin-react": "5.1.0",
                vite: "7.2.2",
              },
            },
            null,
            2,
          ),
        },
        {
          path: at("vite.config.js"),
          contents: `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\n// "./" so the built app asks for its files relatively, as it must behind its link.\nexport default defineConfig({ base: "./", plugins: [react()] });\n`,
        },
        { path: at("server.ts"), contents: BUN_SERVER },
        {
          path: at("index.html"),
          contents: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${name}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="./src/main.jsx"></script>\n  </body>\n</html>\n`,
        },
        {
          path: at("src/main.jsx"),
          contents: `import { createRoot } from "react-dom/client";\nimport { App } from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
        },
        {
          path: at("src/App.jsx"),
          contents: `import { useEffect, useState } from "react";\n\nexport function App() {\n  const [message, setMessage] = useState("…");\n  useEffect(() => {\n    fetch("./api/hello").then((r) => r.json()).then((answer) => setMessage(answer.message));\n  }, []);\n  return (\n    <main style={{ fontFamily: "system-ui", padding: 24 }}>\n      <h1>${name}</h1>\n      <p>{message}</p>\n    </main>\n  );\n}\n`,
        },
      ];
  }
}
