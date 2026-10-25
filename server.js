// Moinho Raios · Controle de Farinha — servidor
// No computador da loja não precisa instalar pacotes: só o Node.js (versão 18 ou mais nova).
// Para iniciar:  node server.js     (ou dê dois cliques em iniciar.bat no Windows)
// Na internet (Render): defina DATABASE_URL (Postgres/Neon) e SENHA_ADMIN_INICIAL.

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const VERSAO = "1.10.1";
const PORTA = Number(process.env.PORTA || process.env.PORT || 3000);
const PASTA_DADOS = path.join(__dirname, "dados");
const ARQ_BANCO = path.join(PASTA_DADOS, "banco.json");
const PASTA_BACKUP = path.join(PASTA_DADOS, "backups");
const PAGINA = path.join(__dirname, "public", "index.html");

// Mensagens são temporárias: somem 24 horas depois de enviadas
const VALIDADE_MSG = 24 * 60 * 60 * 1000;
const COLECOES = ["produtos", "movimentos", "contas", "mensagens"];
const PAPEIS = ["admin", "operador", "acompanhante", "mensagens"];
// "mensagens": só usa o chat; não recebe nenhum dado de estoque ou financeiro
// Quem pode lançar dados de estoque e financeiro
const PODE_LANCAR = ["admin", "operador"];

/* ---------------- banco de dados ----------------
   No computador da loja: arquivo dados/banco.json (sem instalar nada).
   Na internet (Render): se existir a variável DATABASE_URL, os dados ficam no Postgres (Neon). */
const NUVEM = !!process.env.DATABASE_URL;
let pool = null;

function bancoVazio() {
  return { rev: 1, produtos: {}, movimentos: {}, contas: {}, mensagens: {}, usuarios: {}, sessoes: {} };
}
let banco;

function hashSenha(senha, salt) {
  return crypto.scryptSync(String(senha), salt, 64).toString("hex");
}
function novoId() {
  return Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
}
function hojeISO() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }

async function carregar() {
  if (NUVEM) {
    const { Pool } = require("pg");
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.delete("sslmode"); u.searchParams.delete("channel_binding");
    pool = new Pool({ connectionString: u.toString(), ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: true }, max: 3 });
    await pool.query("create table if not exists moinho_estado (id text primary key, dados jsonb not null, atualizado timestamptz not null default now())");
    await pool.query("create table if not exists moinho_backups (dia text primary key, dados jsonb not null)");
    const r = await pool.query("select dados from moinho_estado where id = 'banco'");
    return r.rows[0] ? r.rows[0].dados : null;
  }
  fs.mkdirSync(PASTA_BACKUP, { recursive: true });
  try { return JSON.parse(fs.readFileSync(ARQ_BANCO, "utf8")); }
  catch (e) {
    if (fs.existsSync(ARQ_BANCO)) {
      console.error("\n[ERRO] O arquivo dados/banco.json está corrompido. Restaure um backup da pasta dados/backups.\n");
      process.exit(1);
    }
    return null;
  }
}

// Grava o banco inteiro; se chegar outra alteração no meio da gravação, grava de novo no fim.
let salvando = false, pendente = false, ultimoBackup = "";
function salvar() {
  banco.rev++;
  if (salvando) { pendente = true; return; }
  salvando = true;
  gravar().catch(e => { console.error("Falha ao gravar dados:", e.message); pendente = true; return new Promise(r => setTimeout(r, 3000)); })
    .finally(() => { salvando = false; if (pendente) { pendente = false; banco.rev--; salvar(); } });
}
async function gravar() {
  const json = JSON.stringify(banco);
  // backup diário sem mensagens (são temporárias) e sem sessões de login
  const dia = hojeISO(), copia = dia !== ultimoBackup ? JSON.stringify({ ...banco, mensagens: {}, sessoes: {} }) : null;
  if (NUVEM) {
    await pool.query("insert into moinho_estado (id, dados) values ('banco', $1::jsonb) on conflict (id) do update set dados = excluded.dados, atualizado = now()", [json]);
    if (copia) {
      await pool.query("insert into moinho_backups (dia, dados) values ($1, $2::jsonb) on conflict (dia) do nothing", [dia, copia]);
      await pool.query("delete from moinho_backups where dia not in (select dia from moinho_backups order by dia desc limit 60)");
      ultimoBackup = dia;
    }
    return;
  }
  const tmp = ARQ_BANCO + ".tmp";
  await fs.promises.writeFile(tmp, json);
  await fs.promises.rename(tmp, ARQ_BANCO);
  if (copia) {
    const arq = path.join(PASTA_BACKUP, "banco-" + dia + ".json");
    if (!fs.existsSync(arq)) {
      fs.writeFileSync(arq, copia);
      const todos = fs.readdirSync(PASTA_BACKUP).filter(f => f.startsWith("banco-")).sort();
      todos.slice(0, Math.max(0, todos.length - 60)).forEach(f => fs.unlinkSync(path.join(PASTA_BACKUP, f)));
    }
    ultimoBackup = dia;
  }
}
// Espera a última gravação terminar (usado ao desligar o servidor)
async function terminarGravacao() { for (let i = 0; i < 50 && (salvando || pendente); i++) await new Promise(r => setTimeout(r, 100)); }

/* ---------------- utilidades HTTP ---------------- */
function responder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(corpo);
}
function erro(res, status, msg) { responder(res, status, { erro: msg }); }
function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let tam = 0; const partes = [];
    req.on("data", c => { tam += c.length; if (tam > 1e6) { falha(new Error("grande")); req.destroy(); } else partes.push(c); });
    req.on("end", () => { if (!partes.length) return ok({}); try { const v = JSON.parse(Buffer.concat(partes).toString("utf8")); ok(v && typeof v === "object" && !Array.isArray(v) ? v : {}); } catch (e) { falha(e); } });
    req.on("error", falha);
  });
}
function publico(u) { return { id: u.id, usuario: u.usuario, nome: u.nome, papel: u.papel, trocarSenha: !!u.trocarSenha }; }
function usuarioDaRequisicao(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const s = banco.sessoes[m[1]];
  if (!s) return null;
  const u = banco.usuarios[s.usuarioId];
  return u ? { ...u, token: m[1] } : null;
}
function limpar(doc) {
  const d = { ...doc }; delete d.id; return d;
}
// Mensagens que este usuário pode ver: o canal Geral e as conversas privadas em que ele participa.
// Mensagens privadas de outras pessoas nunca são enviadas, nem para o administrador.
function limparMensagensVencidas() {
  const limite = Date.now() - VALIDADE_MSG;
  let apagou = false;
  for (const [id, m] of Object.entries(banco.mensagens)) if ((m.criadoEm || 0) < limite) { delete banco.mensagens[id]; apagou = true; }
  if (apagou) salvar();
}
function listaMensagens(eu) {
  const limite = Date.now() - VALIDADE_MSG;
  const todas = Object.values(banco.mensagens).filter(m => (m.criadoEm || 0) >= limite).sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
  const geral = todas.filter(m => !m.para).slice(0, 300);
  const privadas = todas.filter(m => m.para && (m.para === eu.id || m.autor === eu.id)).slice(0, 1000);
  return geral.concat(privadas);
}

/* ---------------- rotas ---------------- */
const tentativas = new Map(); // login errado: bloqueia por 15 min após 8 tentativas
setInterval(() => { const lim = Date.now() - 15 * 60 * 1000; for (const [k, v] of tentativas) if (v.desde < lim) tentativas.delete(k); }, 5 * 60 * 1000);
async function api(req, res, url) {
  const p = url.pathname.replace(/\/+$/, "");
  const metodo = req.method;

  if (p === "/api/info" && metodo === "GET") return responder(res, 200, { versao: VERSAO });

  if (p === "/api/login" && metodo === "POST") {
    const b = await lerCorpo(req);
    const origem = String(req.headers["cf-connecting-ip"] || (NUVEM && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "");
    const chave = origem + "|" + String(b.usuario || "").trim().toLowerCase();
    const t = tentativas.get(chave);
    if (t && t.n >= 8 && Date.now() - t.desde < 15 * 60 * 1000)
      return erro(res, 429, "Muitas tentativas erradas. Aguarde 15 minutos e tente de novo.");
    const u = Object.values(banco.usuarios).find(x => x.usuario.toLowerCase() === String(b.usuario || "").trim().toLowerCase());
    if (!u || hashSenha(b.senha || "", u.salt) !== u.hash) {
      const atual = t && Date.now() - t.desde < 15 * 60 * 1000 ? t : { n: 0, desde: Date.now() };
      atual.n++; tentativas.set(chave, atual);
      return erro(res, 401, "Usuário ou senha incorretos.");
    }
    tentativas.delete(chave);
    const token = crypto.randomBytes(24).toString("hex");
    banco.sessoes[token] = { usuarioId: u.id, criadoEm: Date.now() };
    salvar();
    return responder(res, 200, { token, usuario: publico(u) });
  }

  const eu = usuarioDaRequisicao(req);
  if (!eu) return erro(res, 401, "Faça login para continuar.");

  if (p === "/api/logout" && metodo === "POST") { delete banco.sessoes[eu.token]; salvar(); return responder(res, 200, { ok: true }); }
  if (p === "/api/eu" && metodo === "GET") return responder(res, 200, { usuario: publico(eu), versao: VERSAO });

  if (p === "/api/senha" && metodo === "POST") {
    const b = await lerCorpo(req);
    const u = banco.usuarios[eu.id];
    if (hashSenha(b.atual || "", u.salt) !== u.hash) return erro(res, 400, "A senha atual não confere.");
    if (String(b.nova || "").length < 4) return erro(res, 400, "A nova senha precisa ter pelo menos 4 caracteres.");
    u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashSenha(b.nova, u.salt); u.trocarSenha = false;
    salvar();
    return responder(res, 200, { usuario: publico(u) });
  }

  if (p === "/api/dados" && metodo === "GET") {
    const rev = Number(url.searchParams.get("rev") || 0);
    if (rev === banco.rev) return responder(res, 200, { rev: banco.rev, igual: true, versao: VERSAO });
    return responder(res, 200, {
      rev: banco.rev, versao: VERSAO,
      ...(eu.papel === "mensagens"
        ? { produtos: [], movimentos: [], contas: [] }
        : { produtos: Object.values(banco.produtos), movimentos: Object.values(banco.movimentos), contas: Object.values(banco.contas) }),
      mensagens: listaMensagens(eu),
      pessoas: Object.values(banco.usuarios).map(u => ({ id: u.id, nome: u.nome, papel: u.papel }))
    });
  }

  /* --- usuários (só administrador) --- */
  if (p === "/api/usuarios" || p.startsWith("/api/usuarios/")) {
    if (eu.papel !== "admin") return erro(res, 403, "Só o administrador gerencia usuários.");
    const id = p.split("/")[3];
    if (!id && metodo === "GET") return responder(res, 200, { usuarios: Object.values(banco.usuarios).map(publico) });
    if (!id && metodo === "POST") {
      const b = await lerCorpo(req);
      const login = String(b.usuario || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,30}$/.test(login)) return erro(res, 400, "Usuário deve ter de 2 a 30 letras, números, ponto ou traço, sem espaços.");
      if (Object.values(banco.usuarios).some(u => u.usuario === login)) return erro(res, 400, "Já existe um usuário com esse login.");
      if (!PAPEIS.includes(b.papel)) return erro(res, 400, "Escolha o tipo de acesso.");
      if (String(b.senha || "").length < 4) return erro(res, 400, "A senha precisa ter pelo menos 4 caracteres.");
      const nid = novoId(), salt = crypto.randomBytes(16).toString("hex");
      banco.usuarios[nid] = { id: nid, usuario: login, nome: String(b.nome || login).trim().slice(0, 60), papel: b.papel, salt, hash: hashSenha(b.senha, salt), trocarSenha: true, criadoEm: Date.now() };
      salvar();
      return responder(res, 200, { usuario: publico(banco.usuarios[nid]) });
    }
    const alvo = banco.usuarios[id];
    if (!alvo) return erro(res, 404, "Usuário não encontrado.");
    const admins = Object.values(banco.usuarios).filter(u => u.papel === "admin");
    if (metodo === "PATCH") {
      const b = await lerCorpo(req);
      if (b.papel !== undefined) {
        if (!PAPEIS.includes(b.papel)) return erro(res, 400, "Tipo de acesso inválido.");
        if (alvo.papel === "admin" && b.papel !== "admin" && admins.length === 1) return erro(res, 400, "O sistema precisa de pelo menos um administrador.");
        alvo.papel = b.papel;
      }
      if (b.nome !== undefined) alvo.nome = String(b.nome).trim().slice(0, 60) || alvo.usuario;
      if (b.senha !== undefined) {
        if (String(b.senha).length < 4) return erro(res, 400, "A senha precisa ter pelo menos 4 caracteres.");
        alvo.salt = crypto.randomBytes(16).toString("hex"); alvo.hash = hashSenha(b.senha, alvo.salt); alvo.trocarSenha = true;
        for (const [t, s] of Object.entries(banco.sessoes)) if (s.usuarioId === id && t !== eu.token) delete banco.sessoes[t];
      }
      salvar();
      return responder(res, 200, { usuario: publico(alvo) });
    }
    if (metodo === "DELETE") {
      if (id === eu.id) return erro(res, 400, "Você não pode excluir o próprio usuário.");
      if (alvo.papel === "admin" && admins.length === 1) return erro(res, 400, "O sistema precisa de pelo menos um administrador.");
      delete banco.usuarios[id];
      for (const [t, s] of Object.entries(banco.sessoes)) if (s.usuarioId === id) delete banco.sessoes[t];
      salvar();
      return responder(res, 200, { ok: true });
    }
  }

  /* --- coleções --- */
  const m = /^\/api\/c\/([a-z]+)(?:\/([A-Za-z0-9_.:-]+))?$/.exec(p);
  if (m && COLECOES.includes(m[1])) {
    const col = m[1], id = m[2];
    const ehMsg = col === "mensagens";
    if (!ehMsg && !PODE_LANCAR.includes(eu.papel)) return erro(res, 403, "Seu acesso é somente leitura.");
    if (!id && metodo === "POST") {
      const b = limpar(await lerCorpo(req));
      if (ehMsg) {
        const texto = String(b.texto || "").trim().slice(0, 1000);
        if (!texto) return erro(res, 400, "Mensagem vazia.");
        let para = null;
        if (b.para) {
          if (!banco.usuarios[b.para] || b.para === eu.id) return erro(res, 400, "Destinatário inválido.");
          para = b.para;
        }
        const nid = novoId();
        banco.mensagens[nid] = { id: nid, autor: eu.id, para, texto, criadoEm: Date.now() };
        const ids = Object.keys(banco.mensagens);
        if (ids.length > 10000) listaOrdenadaAntigas(ids.length - 10000).forEach(k => delete banco.mensagens[k]);
        salvar();
        return responder(res, 200, { id: nid });
      }
      const nid = novoId();
      banco[col][nid] = { ...b, id: nid, criadoPor: eu.id };
      salvar();
      return responder(res, 200, { id: nid });
    }
    const atual = id && banco[col][id];
    if (!atual) return erro(res, 404, "Registro não encontrado. Clique em Atualizar dados.");
    if (metodo === "PATCH") {
      if (ehMsg) return erro(res, 403, "Mensagens não podem ser editadas.");
      banco[col][id] = { ...atual, ...limpar(await lerCorpo(req)), id };
      salvar();
      return responder(res, 200, { ok: true });
    }
    if (metodo === "DELETE") {
      if (ehMsg && atual.autor !== eu.id && !(eu.papel === "admin" && !atual.para)) return erro(res, 403, "Você só pode apagar as próprias mensagens.");
      delete banco[col][id];
      salvar();
      return responder(res, 200, { ok: true });
    }
  }
  return erro(res, 404, "Rota não encontrada.");
}
function listaOrdenadaAntigas(n) {
  return Object.values(banco.mensagens).sort((a, b) => (a.criadoEm || 0) - (b.criadoEm || 0)).slice(0, n).map(m => m.id);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const ESTATICOS = { "/index.html": "text/html; charset=utf-8", "/icone.svg": "image/svg+xml", "/icone-180.png": "image/png", "/icone-512.png": "image/png", "/manifest.json": "application/manifest+json", "/sw.js": "application/javascript; charset=utf-8" };
    const rota = url.pathname === "/" ? "/index.html" : url.pathname;
    if (req.method === "GET" && ESTATICOS[rota]) {
      // procura em public/ e, se não achar, na pasta principal (caso os arquivos tenham sido enviados soltos)
      const nome = rota.slice(1);
      const arq = [path.join(__dirname, "public", nome), path.join(__dirname, nome)].find(f => fs.existsSync(f));
      if (!arq) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Arquivo " + nome + " não encontrado no servidor. Envie a pasta public."); }
      const cache = rota === "/index.html" || rota === "/sw.js" ? "no-cache" : "max-age=3600";
      res.writeHead(200, { "Content-Type": ESTATICOS[rota], "Cache-Control": cache });
      const fluxo = fs.createReadStream(arq);
      fluxo.on("error", () => res.end());
      return fluxo.pipe(res);
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Página não encontrada");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) erro(res, 400, "Requisição inválida.");
  }
});

servidor.on("error", e => {
  if (e.code === "EADDRINUSE") console.error(`\n[ERRO] A porta ${PORTA} já está em uso. Feche a outra janela do sistema ou use outra porta: set PORTA=3001\n`);
  else console.error(e);
  process.exit(1);
});

async function iniciar() {
  try { banco = await carregar(); }
  catch (e) {
    console.error("\n[ERRO] Não foi possível abrir o banco de dados: " + e.message);
    console.error("Confira a variável DATABASE_URL (endereço do Neon).\n");
    process.exit(1);
  }
  if (!banco) banco = bancoVazio();
  for (const k of Object.keys(bancoVazio())) if (banco[k] === undefined) banco[k] = bancoVazio()[k];
  // Primeiro uso: cria o administrador. Na internet, use a variável SENHA_ADMIN_INICIAL.
  if (!Object.keys(banco.usuarios).length) {
    const id = novoId(), salt = crypto.randomBytes(16).toString("hex");
    banco.usuarios[id] = { id, usuario: "admin", nome: "Administrador", papel: "admin", salt, hash: hashSenha(process.env.SENHA_ADMIN_INICIAL || "admin", salt), trocarSenha: true, criadoEm: Date.now() };
  }
  limparMensagensVencidas();
  setInterval(limparMensagensVencidas, 60 * 1000);
  salvar();
  servidor.listen(PORTA, "0.0.0.0", aoIniciar);
}
// Ao desligar (o Render faz isso a cada atualização), termina de gravar antes de sair
for (const sinal of ["SIGTERM", "SIGINT"]) process.on(sinal, async () => {
  servidor.close(); await terminarGravacao(); if (pool) await pool.end().catch(() => {}); process.exit(0);
});
function aoIniciar() {
  if (NUVEM) {
    console.log("Moinho Raios · Controle de Farinha · versão " + VERSAO + " · na internet, dados no Postgres · porta " + PORTA);
    return;
  }
  const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|vbox|tailscale|zerotier|bluetooth|vpn|tap|tun/i;
  const ips = [];
  for (const [nome, lista] of Object.entries(os.networkInterfaces()))
    for (const i of lista || []) if (i.family === "IPv4" && !i.internal && !VIRTUAL.test(nome)) ips.push({ ip: i.address, nome });
  const prioridade = ip => ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3;
  ips.sort((a, b) => prioridade(a.ip) - prioridade(b.ip));
  console.log("\n  MOINHO RAIOS · CONTROLE DE FARINHA  ·  versão " + VERSAO);
  console.log("  ------------------------------------------");
  console.log("  Neste computador:  http://localhost:" + PORTA);
  if (!ips.length) console.log("  Nenhuma rede encontrada. Confira se o computador está no Wi-Fi ou no cabo.");
  ips.forEach((x, n) => console.log((n === 0 ? "  Celular (mesmo Wi-Fi):  " : "  Outro endereço:        ") + "http://" + x.ip + ":" + PORTA + "   (" + x.nome + ")"));
  console.log("  Celular não abre? Rode liberar-firewall.bat (uma vez só).");
  console.log("  Acesso fora da loja (internet): rode tunel.bat com esta janela aberta.");
  console.log("\n  Dados salvos em: " + ARQ_BANCO);
  if (Object.values(banco.usuarios).some(u => u.usuario === "admin" && u.trocarSenha))
    console.log("  Primeiro acesso: usuário admin / senha admin (o sistema pede para trocar)");
  console.log("\n  Deixe esta janela aberta enquanto usar o sistema.\n");
}
iniciar();
