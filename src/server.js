'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { buildXodr } = require('./xodrSerializer');

const publicDir = path.join(__dirname, '..', 'public');
const distDir = path.join(__dirname, '..', 'dist');
const nativeParserPath = path.join(__dirname, '..', 'native', 'bin', 'odr_json_parser');
const vtsRuntimeDir = path.join(__dirname, '..', '..', 'vts_map_interface', 'build_unix', 'runtime');
const mapcheckCandidates = [
  process.env.MAPCHECK_BIN ? String(process.env.MAPCHECK_BIN).trim() : '',
  path.join(__dirname, '..', 'native', 'bin', 'check_map'),
  path.join(__dirname, '..', 'native', 'bin', 'mapcheck'),
  path.join(vtsRuntimeDir, 'VTSMapCheckApp'),
  'check_map'
].filter(Boolean);
const routeTestCandidates = [
  process.env.MAPROUTE_BIN ? String(process.env.MAPROUTE_BIN).trim() : '',
  process.env.ROUTE_TEST_BIN ? String(process.env.ROUTE_TEST_BIN).trim() : '',
  path.join(__dirname, '..', 'native', 'bin', 'route_test'),
  path.join(vtsRuntimeDir, 'VTSMapRouteApp'),
  'route_test'
].filter(Boolean);
const staticDir = fs.existsSync(distDir) ? distDir : publicDir;
const port = Number(process.env.BACKEND_PORT || process.env.PORT || 5173);

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

function looksLikePath(s) {
  return s.includes('/') || s.includes('\\');
}

function classifyMapcheckOutput(rawOutput) {
  const lines = String(rawOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const errors = [];
  const warnings = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('no error/warn message')) {
      continue;
    }
    if (lower.includes('warning') || lower.includes('[ warning ]')) {
      warnings.push(line);
      continue;
    }
    if (lower.includes('error') || lower.includes('[ error ]')) {
      errors.push(line);
    }
  }

  const uniqErrors = [...new Set(errors)];
  const uniqWarnings = [...new Set(warnings)];
  return {
    errors: uniqErrors,
    warnings: uniqWarnings,
    errorCount: uniqErrors.length,
    warningCount: uniqWarnings.length,
    ok: uniqErrors.length === 0
  };
}

function runMapcheckOnXodr(xodrText) {
  return new Promise((resolve, reject) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odr-check-'));
    const tempFile = path.join(tempDir, 'map.xodr');
    fs.writeFileSync(tempFile, String(xodrText || ''), 'utf8');

    const tryRun = (idx) => {
      if (idx >= mapcheckCandidates.length) {
        const hint = process.env.MAPCHECK_BIN
          ? `MAPCHECK_BIN=${process.env.MAPCHECK_BIN}`
          : 'native/bin/check_map 或设置环境变量 MAPCHECK_BIN';
        try { fs.unlinkSync(tempFile); } catch (_) {}
        try { fs.rmdirSync(tempDir); } catch (_) {}
        reject(new Error(`未找到可用的原版 mapcheck/check_map。请安装后重试（${hint}）。`));
        return;
      }

      const bin = mapcheckCandidates[idx];
      if (looksLikePath(bin) && !fs.existsSync(bin)) {
        tryRun(idx + 1);
        return;
      }

      execFile(
        bin,
        [tempFile],
        { maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const raw = [stdout || '', stderr || ''].filter(Boolean).join('\n').trim();
          const classified = classifyMapcheckOutput(raw);

          if (error) {
            if (error.code === 'ENOENT') {
              tryRun(idx + 1);
              return;
            }
            if (!raw) {
              try { fs.unlinkSync(tempFile); } catch (_) {}
              try { fs.rmdirSync(tempDir); } catch (_) {}
              reject(new Error(`原版 mapcheck 执行失败: ${String(error.message || error)}`));
              return;
            }
          }

          try { fs.unlinkSync(tempFile); } catch (_) {}
          try { fs.rmdirSync(tempDir); } catch (_) {}

          resolve({
            ...classified,
            tool: bin
          });
        }
      );
    };

    tryRun(0);
  });
}

function classifyRouteTestOutput(rawOutput) {
  const lines = String(rawOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const errors = [];
  let summary = null;
  for (const line of lines) {
    if (/^\[\s*FAIL\s*\]/i.test(line) || line.toLowerCase().includes('load map failed')) {
      errors.push(line);
      continue;
    }
    if (line.toLowerCase().includes('not enough valid roads')) {
      continue;
    }
    const match = line.match(/summary:\s*ok=(\d+),\s*fail=(\d+),\s*total=(\d+),\s*sample_fail=(\d+)/i);
    if (match) {
      summary = {
        ok: Number(match[1] || 0),
        fail: Number(match[2] || 0),
        total: Number(match[3] || 0),
        sampleFail: Number(match[4] || 0)
      };
    }
  }

  const errorCount = summary ? summary.fail : errors.length;
  const warnings = [];
  if (summary) {
    warnings.push(`[ROUTE] summary: ok=${summary.ok}, fail=${summary.fail}, total=${summary.total}, sample_fail=${summary.sampleFail}`);
  } else {
    warnings.push('[ROUTE] route_test executed (summary not found in output)');
  }

  const uniqErrors = [...new Set(errors)];
  const uniqWarnings = [...new Set(warnings)];
  return {
    errors: uniqErrors,
    warnings: uniqWarnings,
    errorCount: summary ? summary.fail : uniqErrors.length,
    warningCount: uniqWarnings.length,
    ok: (summary ? summary.fail : uniqErrors.length) === 0,
    summary
  };
}

function runRouteTestOnXodr(xodrText) {
  return new Promise((resolve, reject) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odr-route-'));
    const tempFile = path.join(tempDir, 'map.xodr');
    fs.writeFileSync(tempFile, String(xodrText || ''), 'utf8');

    const tryRun = (idx) => {
      if (idx >= routeTestCandidates.length) {
        const hint = process.env.MAPROUTE_BIN || process.env.ROUTE_TEST_BIN
          ? `MAPROUTE_BIN=${process.env.MAPROUTE_BIN || process.env.ROUTE_TEST_BIN}`
          : 'native/bin/route_test 或设置环境变量 MAPROUTE_BIN';
        try { fs.unlinkSync(tempFile); } catch (_) {}
        try { fs.rmdirSync(tempDir); } catch (_) {}
        reject(new Error(`未找到可用的原版 route_test。请安装后重试（${hint}）。`));
        return;
      }

      const bin = routeTestCandidates[idx];
      if (looksLikePath(bin) && !fs.existsSync(bin)) {
        tryRun(idx + 1);
        return;
      }

      execFile(
        bin,
        [tempFile],
        { maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const raw = [stdout || '', stderr || ''].filter(Boolean).join('\n').trim();
          const classified = classifyRouteTestOutput(raw);

          if (error) {
            if (error.code === 'ENOENT') {
              tryRun(idx + 1);
              return;
            }
            if (!raw) {
              try { fs.unlinkSync(tempFile); } catch (_) {}
              try { fs.rmdirSync(tempDir); } catch (_) {}
              reject(new Error(`原版 route_test 执行失败: ${String(error.message || error)}`));
              return;
            }
          }

          try { fs.unlinkSync(tempFile); } catch (_) {}
          try { fs.rmdirSync(tempDir); } catch (_) {}

          resolve({
            ...classified,
            tool: bin
          });
        }
      );
    };

    tryRun(0);
  });
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
      const mapcheck = await runMapcheckOnXodr(xodr);
      const routeTest = await runRouteTestOnXodr(xodr);

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
        mapcheckTool: mapcheck.tool || '',
        routeTool: routeTest.tool || '',
        routeSummary: routeTest.summary || null
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
  console.log(`OpenDRIVE backend is running at http://localhost:${port}`);
});
