// Builds a single self-contained page (no doctype/html/head/body wrapper) for publishing as a claude.ai artifact.
// node tools/build-artifact.js <out.html>
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const out = process.argv[2] || path.join(root, 'dist', 'launchbench.html');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'engine.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
for (const [name, src] of [['engine.js', engine], ['app.js', app]]) if (/<\/script/i.test(src)) throw new Error(name + ' contains a closing script tag');

const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const fonts = (html.match(/<link rel="preconnect"[^>]*>|<link rel="stylesheet" href="https:\/\/fonts[^>]*>/g) || []).join('\n');
let body = html.split('<!--BODY-->')[1].split('<!--/BODY-->')[0];
body = body.replace('<script src="engine.js"></script>', () => `<script>\n${engine}\n</script>`)
  .replace('<script src="app.js"></script>', () => `<script>\n${app}\n</script>`);
const page = `${title}\n${fonts}\n<style>\n${css}\n</style>\n${body.trim()}\n`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
