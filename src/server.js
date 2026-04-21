'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { buildXodr } = require('./xodrSerializer');
const { generateJunctionFromApproaches } = require('./junctionGenerator');
const { validateMapSpec, validateRouteConnectivity } = require('./vtsRules');

const publicDir = path.join(__dirname, '..', 'public');
const distDir = path.join(__dirname, '..', 'dist');
const nativeParserPath = path.join(__dirname, '..', 'native', 'bin', 'odr_json_parser');
const staticDir = fs.existsSync(distDir) ? distDir : publicDir;
const port = Number(process.env.BACKEND_PORT || process.env.PORT || 5173);
const validationMode = 'js';

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

function runJsValidation(spec) {
  const mapcheck = validateMapSpec(spec || {});
  const route = validateRouteConnectivity(spec || {});
  const formatLines = (title, result, summaryText = '') => {
    const lines = [title];
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    const logs = Array.isArray(result?.logs) ? result.logs : [];
    if (summaryText) lines.push(summaryText);
    if (logs.length) {
      logs.forEach((item) => lines.push(String(item)));
    }
    if (!errors.length && !warnings.length && !logs.length) {
      lines.push('[ OK ] no error/warn message');
    } else {
      warnings.forEach((item) => lines.push(String(item)));
      errors.forEach((item) => lines.push(String(item)));
    }
    return lines.join('\n');
  };
  const routeSummary = route?.summary
    ? `[ROUTE] summary: ok=${Number(route.summary.ok || 0)}, fail=${Number(route.summary.fail || 0)}, total=${Number(route.summary.total || 0)}, sample_fail=${Number(route.summary.sampleFail || 0)}`
    : '';
  return {
    mapcheck: {
      ...mapcheck,
      rawOutput: formatLines('[JS] mapcheck via vtsRules', mapcheck),
      tool: 'js-mapcheck'
    },
    route: {
      ok: Boolean(route.ok),
      errors: Array.isArray(route.errors) ? route.errors : [],
      warnings: Array.isArray(route.warnings) ? route.warnings : [],
      errorCount: Array.isArray(route.errors) ? route.errors.length : 0,
      warningCount: Array.isArray(route.warnings) ? route.warnings.length : 0,
      summary: route.summary || null,
      rawOutput: formatLines('[JS] route validation via vtsRules', route, routeSummary),
      tool: 'js-route-rules'
    }
  };
}

function serveStatic(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(decodeURIComponent(requested)).replace(/^\.+/, '');
  const target = path.join(staticDir, safePath);

  if (!target.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(target, (err, data) => {
    if (err) {
      const fallback = path.join(staticDir, 'index.html');
      fs.readFile(fallback, (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallbackData);
      });
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
      const payload = JSON.parse(body || '{}');
      const xodrFromPayload = typeof payload.xodr === 'string' ? payload.xodr.trim() : '';
      const xodr = xodrFromPayload || buildXodr(payload);
      const js = runJsValidation(payload);
      const mapcheck = js.mapcheck;
      const routeTest = js.route;

      const errors = [...(mapcheck.errors || []), ...(routeTest.errors || [])];
      const warnings = [...(mapcheck.warnings || []), ...(routeTest.warnings || [])];
      sendJson(res, 200, {
        ok: Boolean(mapcheck.ok) && Boolean(routeTest.ok),
        errorCount: errors.length,
        warningCount: warnings.length,
        errors,
        warnings,
        inputMode: xodrFromPayload ? 'raw_xodr' : 'generated_from_spec',
        inputLength: xodr.length,
        validationMode,
        mapcheckTool: mapcheck.tool || '',
        routeTool: routeTest.tool || '',
        routeSummary: routeTest.summary || null,
        mapcheckOutput: mapcheck.rawOutput || '',
        routeOutput: routeTest.rawOutput || ''
      });
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

  if (req.url === '/api/generate-junction-spec' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const result = generateJunctionFromApproaches(payload || {});
      sendJson(res, 200, result);
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
  console.log(`OpenDRIVE web tool server running at http://localhost:${port}`);
  console.log(`Validation mode: ${validationMode} (vtsRules JS)`);
});
