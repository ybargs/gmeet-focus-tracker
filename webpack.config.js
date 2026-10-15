const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: {
    background: './src/background.js',
    content: './src/content.js',
    popup: './src/popup.js'
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
        { from: 'src/popup.html', to: 'popup.html' },
        { from: 'src/popup.css', to: 'popup.css' },
        { from: 'dashboard/dist', to: 'dashboard' },
        { from: 'dashboard/assets/1.png', to: 'dashboard/assets/1.png' },
        ...[16, 32, 48, 128].map(size => ({ from: `src/assets/icon-${size}.png`, to: `icon-${size}.png` }))
      ],
    }),
  ],
};
