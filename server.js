// Controle de Farinha — servidor local
// Não precisa instalar pacotes: só o Node.js (versão 18 ou mais nova).
// Para iniciar:  node server.js     (ou dê dois cliques em iniciar.bat no Windows)

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const VERSAO = "1.9.0";
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

/* ---------------- banco de dados (arquivo JSON) ---------------- */
fs.mkdirSync(PASTA_BACKUP, { recursive: true });

function bancoVazio() {
  return { rev: 1, produtos: {}, movimentos: {}, contas: {}, mensagens: {}, usuarios: {}, sessoes: {} };
}
let banco;
try {
  banco = JSON.parse(fs.readFileSync(ARQ_BANCO, "utf8"));
  for (const k of Object.keys(bancoVazio())) if (banco[k] === undefined) banco[k] = bancoVazio()[k];
} catch (e) {
  if (fs.existsSync(ARQ_BANCO)) {
    console.error("\n[ERRO] O arquivo dados/banco.json está corrompido. Restaure um backup da pasta dados/backups.\n");
    process.exit(1);
  }
  banco = bancoVazio();
}

function hashSenha(senha, salt) {
  return crypto.scryptSync(String(senha), salt, 64).toString("hex");
}
function novoId() {
  return Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
}

// Primeiro uso: cria o administrador padrão
if (!Object.keys(banco.usuarios).length) {
  const id = novoId(), salt = crypto.randomBytes(16).toString("hex");
  banco.usuarios[id] = { id, usuario: "admin", nome: "Administrador", papel: "admin", salt, hash: hashSenha("admin", salt), trocarSenha: true, criadoEm: Date.now() };
}

let salvando = false, pendente = false;
function salvar() {
  banco.rev++;
  if (salvando) { pendente = true; return; }
  salvando = true;
  const tmp = ARQ_BANCO + ".tmp";
  fs.writeFile(tmp, JSON.stringify(banco), err => {
    if (!err) {
      try { fs.renameSync(tmp, ARQ_BANCO); } catch (e) { console.error("Falha ao gravar banco:", e.message); }
    } else console.error("Falha ao gravar banco:", err.message);
    salvando = false;
    backupDiario();
    if (pendente) { pendente = false; banco.rev--; salvar(); }
  });
}
function backupDiario() {
  try {
    const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    const arq = path.join(PASTA_BACKUP, "banco-" + d.toISOString().slice(0, 10) + ".json");
    if (fs.existsSync(ARQ_BANCO) && !fs.existsSync(arq)) {
      // backup sem mensagens (são temporárias) e sem sessões de login
      fs.writeFileSync(arq, JSON.stringify({ ...banco, mensagens: {}, sessoes: {} }));
      const todos = fs.readdirSync(PASTA_BACKUP).filter(f => f.startsWith("banco-")).sort();
      todos.slice(0, Math.max(0, todos.length - 60)).forEach(f => fs.unlinkSync(path.join(PASTA_BACKUP, f)));
    }
  } catch (e) { console.error("Falha no backup:", e.message); }
}
salvar();

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
limparMensagensVencidas();
setInterval(limparMensagensVencidas, 60 * 1000);
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
    const origem = String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "");
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
    const ESTATICOS = { "/icone.svg": "image/svg+xml", "/icone-180.png": "image/png", "/icone-512.png": "image/png", "/manifest.json": "application/manifest+json", "/sw.js": "application/javascript; charset=utf-8" };
    if (req.method === "GET" && ESTATICOS[url.pathname]) {
      res.writeHead(200, { "Content-Type": ESTATICOS[url.pathname], "Cache-Control": url.pathname === "/sw.js" ? "no-cache" : "max-age=3600" });
      return fs.createReadStream(path.join(__dirname, "public", url.pathname.slice(1))).pipe(res);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return fs.createReadStream(PAGINA).pipe(res);
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

servidor.listen(PORTA, "0.0.0.0", () => {
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
});
