'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { validateMapSpec } = require('./vtsRules');
const { buildXodr } = require('./xodrSerializer');

const publicDir = path.join(__dirname, '..', 'public');
const nativeParserPath = path.join(__dirname, '..', 'native', 'bin', 'odr_json_parser');
const port = Number(process.env.PORT || 5173);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseXodrNative(xmlText, eps = 0.2) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(nativeParserPath)) {
      reject(new Error(`Native parser not found at ${nativeParserPath}`));
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odr-parse-'));
    const tempFile = path.join(tempDir, 'map.xodr');
    fs.writeFileSync(tempFile, xmlText, 'utf8');

    execFile(
      nativeParserPath,
      [tempFile, String(eps)],
      { maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          if (error) {
            reject(new Error((stderr || error.message || String(error)).trim()));
            return;
          }
          const parsed = JSON.parse(stdout || '{}');
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Native parser output is invalid JSON: ${String(err.message || err)}`));
        } finally {
          try { fs.unlinkSync(tempFile); } catch (_) {}
          try { fs.rmdirSync(tempDir); } catch (_) {}
        }
      }
    );
  });
}

function serveStatic(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(decodeURIComponent(requested)).replace(/^\.+/, '');
  const target = path.join(publicDir, safePath);

  if (!target.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(target);
    const map = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };

    res.writeHead(200, { 'Content-Type': map[ext] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.url === '/api/validate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const spec = JSON.parse(body || '{}');
      const result = validateMapSpec(spec);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url === '/api/generate-xodr' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const spec = JSON.parse(body || '{}');
      const xodr = buildXodr(spec);
      sendJson(res, 200, { xodr });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (req.url === '/api/import-xodr-native' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const xml = String(payload.xml || '');
      const eps = Number(payload.eps);
      if (!xml.trim()) {
        sendJson(res, 400, { error: 'xml is required' });
        return;
      }

      const parsed = await parseXodrNative(xml, Number.isFinite(eps) ? eps : 0.2);
      sendJson(res, 200, parsed);
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`OpenDRIVE web tool is running at http://localhost:${port}`);
});
