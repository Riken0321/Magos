const path = require("path");
const fs = require("fs");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");

function sanitizeFilename(filename) {
  const base = path.basename(filename || "upload");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseMultipartFormData(req, buffer) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) return null;
  const boundary = `--${boundaryMatch[1]}`;
  const boundaryBuffer = Buffer.from(boundary);
  let start = buffer.indexOf(boundaryBuffer);
  while (start !== -1) {
    const next = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length);
    if (next === -1) break;
    const part = buffer.slice(
      start + boundaryBuffer.length + 2,
      next - 2
    );
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const headerText = part.slice(0, headerEnd).toString("utf8");
      const filenameMatch = /filename="([^"]+)"/.exec(headerText);
      if (filenameMatch) {
        const contentTypeMatch = /Content-Type: ([^\r\n]+)/i.exec(headerText);
        return {
          filename: filenameMatch[1],
          contentType: contentTypeMatch
            ? contentTypeMatch[1]
            : "application/octet-stream",
          data: part.slice(headerEnd + 4),
        };
      }
    }
    start = next;
  }
  return null;
}

// Base config that applies to either development or production mode.
const config = {
  entry: "./src/index.js",
  output: {
    // Compile the source files into a bundle.
    filename: "bundle.js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
  },
  // Enable webpack-dev-server to get hot refresh of the app.
  devServer: {
    static: "./build",
    port: 7878,
    hot: true,
    setupMiddlewares: (middlewares, devServer) => {
      if (!devServer) {
        throw new Error("webpack-dev-server is not defined");
      }
      devServer.app.post("/api/upload_music", (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => {
          chunks.push(chunk);
        });
        req.on("end", () => {
          try {
            const buffer = Buffer.concat(chunks);
            const filePart = parseMultipartFormData(req, buffer);
            if (!filePart) {
              res.status(400).json({ ok: false, error: "Invalid form data" });
              return;
            }
            const uploadDir = path.resolve(__dirname, "public", "uploads");
            fs.mkdirSync(uploadDir, { recursive: true });
            const safeName = sanitizeFilename(filePart.filename);
            const targetName = `${Date.now()}_${safeName}`;
            fs.writeFileSync(path.join(uploadDir, targetName), filePart.data);
            res.json({
              ok: true,
              filename: targetName,
              title: path.parse(safeName).name,
              artist: "Local Upload",
            });
          } catch (error) {
            res.status(500).json({ ok: false, error: "Upload failed" });
          }
        });
        req.on("error", () => {
          res.status(500).json({ ok: false, error: "Upload failed" });
        });
      });
      return middlewares;
    },
  },
  module: {
    rules: [
      {
        // Load CSS files. They can be imported into JS files.
        test: /\.css$/i,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    // Generate the HTML index page based on our template.
    // This will output the same index page with the bundle we
    // created above added in a script tag.
    new HtmlWebpackPlugin({
      template: "src/index.html",
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: "public/data.json",
          to: "data.json",
        },
      ],
    }),
  ],
};

module.exports = (env, argv) => {
  if (argv.mode === "development") {
    // Set the output path to the `build` directory
    // so we don't clobber production builds.
    config.output.path = path.resolve(__dirname, "build");

    // Generate source maps for our code for easier debugging.
    // Not suitable for production builds. If you want source maps in
    // production, choose a different one from https://webpack.js.org/configuration/devtool
    config.devtool = "eval-cheap-module-source-map";

    // Include the source maps for Blockly for easier debugging Blockly code.
    config.module.rules.push({
      test: /(blockly\/.*\.js)$/,
      use: [require.resolve("source-map-loader")],
      enforce: "pre",
    });

    // Ignore spurious warnings from source-map-loader
    // It can't find source maps for some Closure modules and that is expected
    config.ignoreWarnings = [/Failed to parse source map/];
  }
  return config;
};
