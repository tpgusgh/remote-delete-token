// 토큰 릴레이: 여러 Claude 계정을 돌려가며 작업 큐를 자동 실행.
// Mac 앱(TokenRelay.app)이 켜져 있는 동안 실행됨. 단독 실행: node server.js
// 접속: Mac 은 localhost, 폰은 Tailscale IP. 접속 키 없음 — Tailscale(내 기기만)로 보호 + 웹사이트발 요청 차단
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, execFile } = require('child_process');

const PORT = +process.env.PORT || 8787;
const LIMIT = 0.95; // 이 사용률 이상이면 다음 계정으로 전환
const DATA = process.env.RELAY_DATA || path.join(__dirname, 'data.json'); // Mac 앱은 Application Support 경로를 넘김
const apkPath = path.join(__dirname, 'TokenRelay.apk'); // 앱 번들에 같이 들어가 /app.apk 로 배포
const CONTINUE_PROMPT = '계정이 전환되었다. 중단된 지점부터 이전 작업을 이어서 끝까지 진행해.';
const LOOP_PROMPT = '지금까지의 결과를 점검하고, 남은 일이나 개선할 점을 스스로 찾아 계속 진행해. 더 할 일이 정말 없으면 품질을 검증하고 개선해.';
const AUTO_PROMPT = '사용자는 자리에 없다. 절대 질문하거나 확인을 요청하지 말고, 합리적인 기본값을 스스로 골라 작업을 끝까지 진행하라. 내린 결정은 마지막 보고에 짧게 적어라.';

let db = fs.existsSync(DATA)
  ? JSON.parse(fs.readFileSync(DATA, 'utf8'))
  : { accounts: [], tasks: [] };
db.settings = { model: '', effort: '', autonomous: true, folders: [], ...db.settings };
const save = () => { fs.writeFileSync(DATA, JSON.stringify(db)); fs.chmodSync(DATA, 0o600); };

// 서버 재시작 시 돌던 작업은 다시 큐로
db.tasks.forEach(t => { if (t.status === 'running') Object.assign(t, { status: 'queued', switched: !!t.sessionId }); });
save();

const id = () => crypto.randomBytes(4).toString('hex');
const now = () => Date.now() / 1000;
const maxUtil = a => Math.max(a.util5h || 0, a.util7d || 0);
// 한도에 걸린 창(5시간/7일)의 리셋 시각까지 사용 불가. 리셋 지나면 자동으로 다시 사용
const blockedUntil = a => Math.max(
  a.util5h >= LIMIT ? a.reset5h || 0 : 0,
  a.util7d >= LIMIT ? a.reset7d || 0 : 0,
  a.limitedUntil || 0,
);
const usable = a => !a.bad && blockedUntil(a) <= now();

function log(t, line) {
  t.log.push(`[${new Date().toLocaleTimeString('ko-KR')}] ${line}`);
  if (t.log.length > 500) t.log.splice(0, t.log.length - 500);
}

let child = null; // ponytail: 한 번에 작업 하나. 병렬 필요하면 계정별 슬롯으로 확장
let waitingLogged = false;

function tick() {
  if (child) return;
  const t = db.tasks.find(t => t.status === 'queued' && !(t.retryAt > now()));
  if (!t) return;
  const a = db.accounts.find(usable);
  if (!a) {
    const until = waitUntil();
    if (!waitingLogged) log(t, `모든 계정 한도 도달. ${until ? new Date(until * 1000).toLocaleString('ko-KR') + ' 리셋 후' : '리셋되면'} 자동으로 이어서 실행`);
    waitingLogged = true;
    return;
  }
  waitingLogged = false;
  run(t, a);
}

function spawnClaude(prompt, cwd, a, resume, extra = []) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...extra];
  if (resume) args.push('--resume', resume);
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: a.token };
  delete env.ANTHROPIC_API_KEY; // API 키가 있으면 OAuth 토큰보다 우선하므로 제거
  return spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// 작업별 모델/effort + 전역 설정(자율 모드, MCP) → claude 플래그
function taskArgs(t) {
  const s = db.settings;
  const args = [];
  const model = t.model || s.model;
  const effort = t.effort || s.effort;
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (s.autonomous) args.push('--append-system-prompt', AUTO_PROMPT, '--disallowedTools', 'AskUserQuestion,EnterPlanMode');
  args.push('--settings', JSON.stringify({ enableAllProjectMcpServers: true })); // 작업 폴더 .mcp.json 도 허용
  return args;
}

// stream-json 의 rate_limit_event 를 계정에 반영. 한도 도달 시 true
function applyUsage(a, ev) {
  const info = ev.rate_limit_info;
  const w = info?.unifiedWindows;
  if (!w) return false;
  a.util5h = w.five_hour?.utilization ?? a.util5h;
  a.util7d = w.seven_day?.utilization ?? a.util7d;
  a.reset5h = w.five_hour?.resetsAt ?? a.reset5h;
  a.reset7d = w.seven_day?.resetsAt ?? a.reset7d;
  a.updated = now();
  a.limitedUntil = 0;
  if (info.status === 'rejected' && maxUtil(a) < LIMIT) a.limitedUntil = info.resetsAt || now() + 3600;
  return info.status === 'rejected' || maxUtil(a) >= LIMIT;
}

// 모든 계정이 막혔을 때 가장 먼저 풀리는 시각
const waitUntil = () => {
  const ts = db.accounts.filter(a => !a.bad).map(blockedUntil).filter(t => t > now());
  return ts.length ? Math.min(...ts) : null;
};
// 등록된 계정 중 가장 먼저 오는 주간(7일) 리셋 시각
const nextWeeklyReset = () => {
  const ts = db.accounts.map(a => a.reset7d).filter(t => t > now());
  return ts.length ? Math.min(...ts) : null;
};

// "주간 리셋되면 중지" 작업: 시각 지나면 대기/실행 중이어도 중지
function enforceWeeklyStops() {
  for (const t of db.tasks) {
    if (!t.untilWeekly || !['queued', 'running'].includes(t.status)) continue;
    t.stopAt ||= nextWeeklyReset();
    if (!t.stopAt || t.stopAt > now()) continue;
    log(t, '⏹ 주간 사용량 초기화 시각 도달. 작업 중지');
    if (t.status === 'running' && child) { t.stopRequested = true; child.kill('SIGTERM'); }
    else t.status = 'stopped';
    save();
  }
}

const LIMIT_RE = /usage limit|rate limit|limit reached|out of extra usage/i;
const AUTH_RE = /401|authenticat|invalid.*(token|api key)|oauth token|please run \/login/i;

function run(t, a) {
  const prompt = t.switched ? CONTINUE_PROMPT : t.iter ? t.loopPrompt || LOOP_PROMPT : t.prompt;
  const resume = t.sessionId || t.resume;
  t.status = 'running';
  t.account = a.name;
  t.switched = false;
  t.retryAt = null;
  log(t, `▶ 계정 [${a.name}] 으로 실행${t.iter ? ` (반복 ${t.iter + 1}회차)` : ''}${resume ? ' (세션 이어서)' : ''}`);
  save();

  const p = (child = spawnClaude(prompt, t.cwd || os.homedir(), a, resume, taskArgs(t)));
  let switching = false;
  const switchAccount = why => {
    if (switching) return;
    switching = true;
    log(t, `⚠ [${a.name}] ${why} → 다음 계정으로 전환`);
    p.kill('SIGTERM');
  };

  readline.createInterface({ input: p.stdout }).on('line', line => {
    let ev;
    try { ev = JSON.parse(line); } catch { return log(t, line); }
    if (ev.type === 'system' && ev.subtype === 'init') t.sessionId = ev.session_id;
    else if (ev.type === 'rate_limit_event') {
      if (applyUsage(a, ev)) switchAccount(`사용량 ${Math.round(maxUtil(a) * 100)}% 도달`);
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) log(t, c.text);
        if (c.type === 'tool_use') log(t, `🔧 ${c.name} ${JSON.stringify(c.input).slice(0, 200)}`);
      }
    } else if (ev.type === 'result') {
      t.result = ev.result;
      if (ev.is_error && LIMIT_RE.test(ev.result || '')) {
        if (usable(a)) a.limitedUntil = now() + 3600; // 리셋 시각 모르면 1시간 후 재시도
        switchAccount('한도 초과 응답');
      } else if (ev.is_error && AUTH_RE.test(ev.result || '')) {
        a.bad = true;
        switchAccount('토큰 인증 실패');
      }
    }
  });
  readline.createInterface({ input: p.stderr }).on('line', l => {
    log(t, `stderr: ${l}`);
    if (AUTH_RE.test(l)) { a.bad = true; switchAccount('토큰 인증 실패'); }
  });

  p.on('close', code => {
    child = null;
    if (switching) { t.status = 'queued'; t.switched = !!t.sessionId; }
    else if (t.stopRequested) t.status = 'stopped';
    else if (t.loop && code === 0) {
      // 반복 모드: 중지 누를 때까지 다음 회차
      t.iter = (t.iter || 0) + 1;
      t.errors = 0;
      t.status = 'queued';
      t.retryAt = now() + 10; // 즉시 끝나는 경우 헛돌며 사용량 태우지 않게 최소 간격
      log(t, `↻ ${t.iter}회차 완료. 다음 반복 대기`);
    } else if (t.loop && (t.errors || 0) < 2 && t.sessionId) {
      // 반복 중 일시 오류(네트워크 등)는 1분 뒤 재시도, 연속 3번이면 멈춤
      t.errors = (t.errors || 0) + 1;
      t.status = 'queued';
      t.switched = true;
      t.retryAt = now() + 60;
      log(t, `⚠ 오류 (연속 ${t.errors}회). 1분 뒤 재시도`);
    } else t.status = code === 0 ? 'done' : 'error';
    if (['done', 'error', 'stopped'].includes(t.status)) log(t, `■ 종료 (${t.status})`);
    save();
    tick();
  });
  p.on('error', e => log(t, `실행 실패: ${e.message}`));
}

// 토큰 동작 여부 + 현재 사용량 확인 (haiku 로 아주 짧게 호출)
function probe(a) {
  return new Promise(resolve => {
    const p = spawnClaude('ok 라고만 답해', os.tmpdir(), a, null, ['--model', 'haiku']);
    let err = '';
    readline.createInterface({ input: p.stdout }).on('line', line => {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'rate_limit_event') applyUsage(a, ev);
        if (ev.type === 'result' && ev.is_error) err = ev.result;
      } catch {}
    });
    p.stderr.on('data', d => (err += d));
    p.on('close', code => {
      a.bad = code !== 0 && AUTH_RE.test(err);
      a.error = code === 0 ? null : err.slice(0, 300);
      save();
      tick();
      resolve();
    });
  });
}

// ---------- HTTP ----------
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const manifest = JSON.stringify({
  name: 'Token Relay', short_name: 'Relay', start_url: '/', display: 'standalone',
  background_color: '#141413', theme_color: '#141413',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
});
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#d97757"/><path d="M28 55h40M53 40l15 15-15 15" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// 접속 키 대신: 폰/Mac 앱만 보내는 헤더(웹사이트가 몰래 보내려면 CORS 사전 요청이 필요해 브라우저가 막음)
// + Host 가 IP/localhost/Tailscale 이름일 때만 허용(DNS 리바인딩 차단)
const HOST_RE = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[\w-]+|[\w.-]+\.ts\.net)(:\d+)?$/i;
const allowed = req => req.headers['x-relay'] === '1' && HOST_RE.test(req.headers.host || '');

const body = req => new Promise(r => {
  let s = '';
  req.on('data', d => (s += d));
  req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } });
});

const state = () => ({
  limit: LIMIT,
  accounts: db.accounts.map(a => ({
    ...a,
    token: a.token.slice(0, 14) + '…' + a.token.slice(-4),
    usable: usable(a),
    blockedUntil: blockedUntil(a) > now() ? blockedUntil(a) : null,
    // 리셋 지난 창은 0% 로 표시
    util5h: a.reset5h < now() ? 0 : a.util5h,
    util7d: a.reset7d < now() ? 0 : a.util7d,
  })),
  tasks: db.tasks.slice().reverse(),
  settings: db.settings,
  home: os.homedir(),
  waitUntil: db.accounts.some(usable) ? null : waitUntil(),
  weeklyReset: nextWeeklyReset(),
});

function addAccount(name, token) {
  const dup = db.accounts.find(a => a.token === token);
  if (dup) return dup;
  const a = { id: id(), name, token, util5h: 0, util7d: 0 };
  db.accounts.push(a);
  save();
  probe(a);
  return a;
}

// ---- claude setup-token 을 앱에서 진행 (폰이든 Mac 이든 브라우저에서 로그인 → 코드 붙여넣기) ----
// setup-token 은 터미널(TTY)이 있어야 동작하므로 파이썬 표준 pty 로 감쌈. 폭을 넓혀 토큰이 줄바꿈되지 않게 함
const PTY_PY = `import os,pty,sys,select,fcntl,termios,struct
pid,fd=pty.fork()
if pid==0:
    fcntl.ioctl(1,termios.TIOCSWINSZ,struct.pack('HHHH',50,1000,0,0))
    os.execvp(sys.argv[1],sys.argv[1:])
while True:
    r,_,_=select.select([fd,0],[],[])
    if fd in r:
        try: d=os.read(fd,4096)
        except OSError: break
        if not d: break
        os.write(1,d)
    if 0 in r:
        d=os.read(0,4096)
        if not d: break
        os.write(fd,d)
`;
const plain = s => s.replace(/\x1b\[\d*C/g, ' ').replace(/\x1b\[[0-9;?>]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '\n');
const logins = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startLogin(name) {
  const L = { id: id(), name, out: '', url: null, account: null };
  const env = { ...process.env, BROWSER: 'true' }; // 서버에서 브라우저 열기 시도 안 함
  delete env.ANTHROPIC_API_KEY;
  L.p = spawn('python3', ['-I', '-c', PTY_PY, 'claude', 'setup-token'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const onData = d => {
    L.out = (L.out + d).slice(-200000);
    const t = plain(L.out);
    L.url ||= t.match(/https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\?[\w%&=.~:\/?#-]+/)?.[0];
    const token = t.match(/sk-ant-oat01-[\w-]{20,}/)?.[0];
    if (token && !L.account) {
      L.account = addAccount(name, token);
      L.p.kill();
    }
  };
  L.p.stdout.on('data', onData);
  L.p.stderr.on('data', onData);
  L.p.on('error', e => (L.out += `\n${e.message} (python3 필요)`));
  L.p.on('close', () => (L.done = true));
  setTimeout(() => L.p.kill(), 15 * 60 * 1000);
  logins.set(L.id, L);
  return L;
}
const tail = L => plain(L.out).split('\n').map(s => s.trim())
  .filter(s => s && !/https?:\/\/|Hold\s*Fn|Paste\s*code|^\*+/i.test(s)).slice(-3).join('\n');

// Tailscale(100.64.0.0/10) 주소
const tsIp = () => Object.values(os.networkInterfaces()).flat()
  .find(i => i.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address))?.address;

// MCP 상태: `claude mcp list` 결과를 파싱해 캐시 (헬스체크라 몇 초 걸림)
let mcp = { checked: null, servers: [], checking: false };
function checkMcp() {
  if (mcp.checking) return;
  mcp.checking = true;
  execFile('claude', ['mcp', 'list'], { cwd: os.homedir(), timeout: 90000 }, (err, out) => {
    const servers = (out || '').split('\n').map(l => l.match(/^(.+?): .* - ([✔✘!])\s*(.*)$/)).filter(Boolean)
      .map(([, name, mark, status]) => ({ name, ok: mark === '✔', status: mark === '✔' ? '연결됨' : mark === '!' ? '인증 필요' : '연결 실패', detail: status }));
    mcp = { checked: now(), servers, checking: false, error: servers.length ? null : (err?.message || '등록된 MCP 없음') };
  });
}

const MODEL_RE = /^[\w.\-\[\]]{0,60}$/;
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (code, data, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  if (url.pathname === '/') return send(200, html, 'text/html; charset=utf-8');
  if (url.pathname === '/manifest.json') return send(200, manifest, 'application/manifest+json');
  if (url.pathname === '/icon.svg') return send(200, icon, 'image/svg+xml');
  // 폰 브라우저로 http://<서버>:8787/app.apk 열면 앱 설치 파일 다운로드 (키 없음, 앱 자체엔 비밀 없음)
  if (url.pathname === '/app.apk' && fs.existsSync(apkPath)) {
    res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="TokenRelay.apk"' });
    return fs.createReadStream(apkPath).pipe(res);
  }
  if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
  if (!allowed(req)) return send(403, { error: '허용되지 않은 요청' });

  const [, , kind, itemId, action] = url.pathname.split('/');
  const m = req.method;
  const acc = db.accounts.find(a => a.id === itemId);
  const task = db.tasks.find(t => t.id === itemId);

  if (kind === 'state' && m === 'GET') return send(200, state());

  if (kind === 'accounts' && m === 'POST' && !itemId) {
    const { name, token } = await body(req);
    if (!name?.trim() || !/^sk-ant-\S+$/.test(token?.trim() || '')) return send(400, { error: '이름과 sk-ant- 로 시작하는 토큰 필요' });
    addAccount(name.trim(), token.trim());
    return send(200, { ok: true });
  }

  // 1단계: 로그인 시작 → 로그인 링크 반환
  if (kind === 'login' && m === 'POST' && !itemId) {
    const { name } = await body(req);
    const L = startLogin(name?.trim() || `계정 ${db.accounts.length + 1}`);
    for (let i = 0; i < 60 && !L.url && !L.done; i++) await sleep(500);
    if (!L.url) { L.p.kill(); return send(500, { error: `로그인 링크를 받지 못함\n${tail(L)}` }); }
    return send(200, { id: L.id, url: L.url });
  }
  // 2단계: 브라우저에 표시된 코드 입력 → 토큰 받아 계정 자동 등록
  if (kind === 'login' && itemId && m === 'POST') {
    const L = logins.get(itemId);
    const { code } = await body(req);
    if (!L || L.done) return send(400, { error: '로그인 세션 만료. 처음부터 다시 시도' });
    if (!code?.trim()) return send(400, { error: '코드 필요' });
    L.p.stdin.write(code.trim());
    await sleep(500);
    L.p.stdin.write('\r');
    for (let i = 0; i < 60 && !L.account && !L.done; i++) await sleep(500);
    logins.delete(L.id);
    L.p.kill();
    if (!L.account) return send(400, { error: `토큰 발급 실패\n${tail(L)}` });
    return send(200, { ok: true, name: L.account.name });
  }
  if (kind === 'accounts' && acc && action === 'probe') { await probe(acc); return send(200, { ok: true }); }
  if (kind === 'accounts' && acc && action === 'up') {
    const i = db.accounts.indexOf(acc);
    if (i > 0) [db.accounts[i - 1], db.accounts[i]] = [db.accounts[i], db.accounts[i - 1]];
    save();
    return send(200, { ok: true });
  }
  if (kind === 'accounts' && acc && m === 'DELETE') { db.accounts.splice(db.accounts.indexOf(acc), 1); save(); return send(200, { ok: true }); }

  if (kind === 'settings' && m === 'PUT') {
    const b = await body(req);
    const s = db.settings;
    if ('model' in b) { if (!MODEL_RE.test(b.model)) return send(400, { error: '모델 이름 형식 오류' }); s.model = b.model; }
    if ('effort' in b) { if (!EFFORTS.includes(b.effort)) return send(400, { error: 'effort 값 오류' }); s.effort = b.effort; }
    if ('autonomous' in b) s.autonomous = !!b.autonomous;
    if ('folders' in b) s.folders = [...new Set(b.folders.filter(f => typeof f === 'string' && fs.existsSync(f)))];
    save();
    return send(200, { ok: true });
  }

  // 폴더 탐색 (작업 폴더 고르기용). 숨김 폴더 제외
  if (kind === 'dirs' && m === 'GET') {
    const dir = path.resolve((url.searchParams.get('path') || '~').replace(/^~/, os.homedir()));
    try {
      const dirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort((x, y) => x.localeCompare(y));
      return send(200, { path: dir, parent: path.dirname(dir), dirs });
    } catch (e) { return send(400, { error: e.message }); }
  }
  // 새 폴더 만들기 (폰에서)
  if (kind === 'dirs' && m === 'POST') {
    const { path: parent, name } = await body(req);
    const n = (name || '').trim();
    if (!n || /[\/\\]/.test(n) || n === '.' || n === '..') return send(400, { error: '폴더 이름이 올바르지 않음' });
    const dir = path.join(path.resolve((parent || '~').replace(/^~/, os.homedir())), n);
    try { fs.mkdirSync(dir); } catch (e) { return send(400, { error: e.code === 'EEXIST' ? '이미 있는 이름' : e.message }); }
    return send(200, { path: dir });
  }

  // 연결된 MCP 상태 (?refresh=1 이면 다시 확인)
  if (kind === 'mcp' && m === 'GET') {
    if (url.searchParams.get('refresh') || !mcp.checked) checkMcp();
    return send(200, mcp);
  }

  if (kind === 'tasks' && m === 'POST' && !itemId) {
    const { prompt, cwd, resume, model = '', effort = '', loop = false, loopPrompt = '', untilWeekly = false } = await body(req);
    if (!prompt?.trim()) return send(400, { error: '작업 내용 필요' });
    if (!MODEL_RE.test(model) || !EFFORTS.includes(effort)) return send(400, { error: '모델/effort 값 오류' });
    const dir = (cwd || '').trim().replace(/^~/, os.homedir()) || os.homedir();
    if (!fs.existsSync(dir)) return send(400, { error: `폴더 없음: ${dir}` });
    db.tasks.push({
      id: id(), prompt: prompt.trim(), cwd: dir, resume: resume || null, model, effort,
      loop: !!loop, loopPrompt: loopPrompt.trim(), iter: 0, status: 'queued', log: [], created: now(),
      untilWeekly: !!untilWeekly, stopAt: untilWeekly ? nextWeeklyReset() : null,
    });
    save();
    tick();
    return send(200, { ok: true });
  }
  // 중지/완료/오류 난 작업을 같은 세션으로 다시 이어서
  if (kind === 'tasks' && task && action === 'resume' && !['queued', 'running'].includes(task.status)) {
    // stopAt 초기화: 주간 중지 작업을 재개하면 다음 주간 리셋까지 진행
    Object.assign(task, { status: 'queued', stopRequested: false, switched: !!task.sessionId, errors: 0, retryAt: null, stopAt: null });
    log(task, '▶ 재개 요청');
    save();
    tick();
    return send(200, { ok: true });
  }
  if (kind === 'tasks' && task && action === 'stop') {
    if (task.status === 'queued') task.status = 'stopped';
    if (task.status === 'running' && child) { task.stopRequested = true; child.kill('SIGTERM'); }
    save();
    return send(200, { ok: true });
  }
  if (kind === 'tasks' && task && m === 'DELETE' && task.status !== 'running') {
    db.tasks.splice(db.tasks.indexOf(task), 1);
    save();
    return send(200, { ok: true });
  }

  send(404, { error: 'not found' });
}

// Mac 화면용 localhost + 폰용 Tailscale IP 에만 열림 (같은 Wi-Fi 다른 기기는 접근 불가)
http.createServer(handle).listen(PORT, '127.0.0.1', () => console.log(`Token Relay 실행 중: http://localhost:${PORT}/`));
let tsBound = null;
function bindTailscale() {
  const ip = tsIp();
  if (!ip || ip === tsBound) return;
  http.createServer(handle).listen(PORT, ip, () => { tsBound = ip; console.log(`폰 접속: http://${ip}:${PORT}/`); })
    .on('error', e => console.log(`Tailscale 주소 연결 실패: ${e.message}`));
}
bindTailscale();
setInterval(bindTailscale, 30000); // Tailscale 이 나중에 켜져도 연결
checkMcp();

// Mac: 서버가 떠 있는 동안 잠자기 방지 (이 프로세스가 끝나면 caffeinate 도 같이 끝남)
if (process.platform === 'darwin') spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref();

setInterval(() => { enforceWeeklyStops(); tick(); if (child) save(); }, 5000);

// 앱 종료 시 실행 중인 claude 도 정리. 작업은 running 으로 남아 다음 실행 때 이어서 진행됨
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { child?.kill('SIGTERM'); process.exit(0); });
