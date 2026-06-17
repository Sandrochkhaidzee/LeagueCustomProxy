const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

// Load .env if present (fall back to empty strings)
try { require('dotenv').config({ quiet: true }); } catch (_) { /* dotenv optional */ }

const isDevBuild = process.env.PROXCHAT_DEV_BUILD === '1';
const cleanOutput = process.env.WEBPACK_CLEAN === '1';

module.exports = {
  mode: isDevBuild ? 'development' : 'production',
  devtool: isDevBuild ? 'source-map' : false,
  cache: {
    type: 'filesystem',
    buildDependencies: {
      config: [__filename],
    },
  },
  entry: {
    background: './src/background/background.ts',
    overlay: './src/overlay/overlay.ts',
    scanner: './src/scanner/scanner.ts',
    'audio-processor': './src/services/audio-worklet/processor.ts',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            // Typecheck separately (e.g. IDE / tsc); speeds webpack rebuilds.
            transpileOnly: true,
          },
        },
        exclude: [/node_modules/, /\.test\.ts$/],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: (pathData) => {
      const name = pathData.chunk?.name ?? '';
      if (name === 'audio-processor') return 'background/audio-processor.js';
      return `${name}/${name}.js`;
    },
    path: path.resolve(__dirname, 'dist'),
    clean: cleanOutput,
  },
  // Desktop Tauri bundle — large ONNX/WASM assets are expected; not a web perf issue.
  performance: {
    hints: false,
  },
  plugins: [
    new webpack.DefinePlugin({
      __DEV_BUILD__: JSON.stringify(isDevBuild),
    }),
    new CopyPlugin({
      patterns: [
        { from: 'icons', to: 'icons' },
        { from: 'src/background/background.html', to: 'background/' },
        { from: 'src/overlay/overlay.html', to: 'overlay/' },
        { from: 'src/overlay/overlay.css', to: 'overlay/' },
        { from: 'src/scanner/scanner.html', to: 'scanner/' },
        { from: 'src/scanner/scanner.css', to: 'scanner/' },
        // Champion classifier model + labels
        { from: 'models/champion_classifier.onnx', to: 'models/' },
        { from: 'models/champion_labels.json', to: 'models/' },
        { from: 'models/champion-icons-manifest.json', to: 'models/' },
        { from: 'models/silero_vad_legacy.onnx', to: 'models/' },
        // ONNX Runtime WASM + MJS loader files (both required for WASM backend)
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.wasm', to: 'background/[name][ext]' },
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.mjs', to: 'background/[name][ext]' },
      ],
    }),
  ],
};
