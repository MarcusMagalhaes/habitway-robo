// HabitWay — robô do WhatsApp (migração 0047; base: robô do Luminway). Roda no GitHub Actions quando há trabalho (o Worker
// pergunta a whatsapp_despertar e dispara o workflow; reserva: horários do workflow) e termina sozinho.
//   1. Pergunta ao banco o que fazer (whatsapp_robo_trabalho): PAREAR (gera o código para digitar no celular) ou ENVIAR.
//   2. Abre a sessão do número da imobiliária (chaves do Baileys no banco, cifradas com CHAVE_SESSAO).
//   3. ENVIAR: lê as mensagens recebidas enquanto esteve fora (whatsapp_entrada: lead no CRM, menu do inquilino, resposta
//      automática na fila) e envia a fila uma por vez (whatsapp_proximo — o banco aplica horário, limites e aquecimento),
//      com "digitando…" e intervalo aleatório. Respostas do atendimento vão na frente e fora do lote. Com o atendimento
//      ligado, fica ouvindo um pouco mais enquanto a conversa está acontecendo.
// Nada pessoal no log (o log do Actions é público no repositório do robô): só ids e contagens.
// Variáveis: SUPABASE_URL, SUPABASE_ANON_KEY, SEGREDO_WHATSAPP, CHAVE_SESSAO (64 hex), TEMPO_MAX_MIN (padrão 12).
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto'
import makeWASocket, { BufferJSON, DisconnectReason, initAuthCreds, proto, Browsers } from 'baileys'
import pino from 'pino'
import { brCodePix } from './pix.mjs'

const { SUPABASE_URL, SUPABASE_ANON_KEY, SEGREDO_WHATSAPP, CHAVE_SESSAO } = process.env
const TEMPO_MAX = Number(process.env.TEMPO_MAX_MIN || 12) * 60_000
const inicio = Date.now()
const restante = () => TEMPO_MAX - (Date.now() - inicio)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`)
for (const k of ['log', 'info', 'warn', 'debug', 'error', 'trace']) console[k] = () => {}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SEGREDO_WHATSAPP || !/^[0-9a-f]{64}$/i.test(CHAVE_SESSAO || '')) {
  log('Faltam variáveis: SUPABASE_URL, SUPABASE_ANON_KEY, SEGREDO_WHATSAPP, CHAVE_SESSAO (64 hex)'); process.exit(1)
}

async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_segredo: SEGREDO_WHATSAPP, ...args }),
  })
  // o log do Actions é público: do erro do banco vai só a mensagem curta (nunca "details"/"hint", que podem trazer dados)
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`${fn}: ${r.status} ${String(j?.message ?? '').slice(0, 160)}`) }
  const t = await r.text()
  return t ? JSON.parse(t) : null
}
const estado = (emp, p) => rpc('whatsapp_robo_estado', { p_empresa: emp, p }).catch((e) => log('estado:', e.message))

// ------------------------------------------------------------------ sessão criptografada no banco
const CHAVE = Buffer.from(CHAVE_SESSAO, 'hex')
function cifrar(obj) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', CHAVE, iv)
  const dados = Buffer.concat([c.update(JSON.stringify(obj, BufferJSON.replacer), 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), dados]).toString('base64')
}
function decifrar(txt) {
  const b = Buffer.from(txt, 'base64'), d = createDecipheriv('aes-256-gcm', CHAVE, b.subarray(0, 12))
  d.setAuthTag(b.subarray(12, 28))
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'), BufferJSON.reviver)
}

async function sessaoDoBanco(emp) {
  const salvas = (await rpc('whatsapp_sessao_ler', { p_empresa: emp })) ?? {}
  const mem = new Map()
  for (const [chave, valor] of Object.entries(salvas)) { try { mem.set(chave, decifrar(valor)) } catch { log('sessão: chave ilegível descartada') } }
  log(`imobiliária ${emp}: sessão com ${mem.size} chave(s)`)
  const creds = mem.get('creds') ?? initAuthCreds()
  const sujas = new Map()
  let gravando = Promise.resolve(), timer = null
  const marcar = (k, v) => { sujas.set(k, v == null ? null : cifrar(v)); if (!timer) timer = setTimeout(gravar, 1500) }
  function gravar() {
    timer = null
    if (!sujas.size) return gravando
    const itens = Object.fromEntries(sujas); sujas.clear()
    gravando = gravando.then(() => rpc('whatsapp_sessao_gravar', { p_empresa: emp, p_itens: itens })).catch((e) => {
      log('sessão: falha ao gravar, tenta de novo', e.message)
      for (const [k, v] of Object.entries(itens)) if (!sujas.has(k)) sujas.set(k, v)
    })
    return gravando
  }
  return {
    novo: !mem.has('creds'),
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const r = {}
          for (const id of ids) {
            let v = mem.get(`${tipo}-${id}`)
            if (tipo === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v)
            r[id] = v
          }
          return r
        },
        set: async (dados) => {
          for (const tipo in dados) for (const id in dados[tipo]) {
            const v = dados[tipo][id], k = `${tipo}-${id}`
            if (v) mem.set(k, v); else mem.delete(k)
            marcar(k, v)
          }
        },
      },
    },
    salvarCreds: () => marcar('creds', creds),
    descarregar: async () => { if (timer) clearTimeout(timer); await gravar(); await gravando; if (sujas.size) await gravar() },
  }
}

// ------------------------------------------------------------------ conexão
const STATUS = { 3: 'ENTREGUE', 4: 'LIDO', 5: 'LIDO' }

function conectar(emp, sessao, { parear, numero, aoCodigo, aoReceber }) {
  const enviadas = new Map()
  return new Promise((resolve, reject) => {
    let codigoPedido = false, encerrado = false
    const abrir = () => {
      const sock = makeWASocket({
        auth: sessao.state, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false,
        syncFullHistory: false, shouldSyncHistoryMessage: () => false, fireInitQueries: false, generateHighQualityLinkPreview: false,
        getMessage: async (key) => enviadas.get(key.id),
      })
      sock.enviadas = enviadas
      sock.ev.on('creds.update', sessao.salvarCreds)
      sock.ev.on('messages.update', (lista) => {
        for (const { key, update } of lista) {
          const st = STATUS[update?.status]
          if (key?.fromMe && st) rpc('whatsapp_recibo', { p_empresa: emp, p_mensagem_id: key.id, p_status: st }).catch(() => {})
        }
      })
      if (aoReceber) sock.ev.on('messages.upsert', ({ messages }) => { for (const m of messages ?? []) aoReceber(m) })
      sock.ev.on('connection.update', async (u) => {
        if (u.qr && parear && !codigoPedido && !sessao.state.creds.registered) {
          codigoPedido = true
          try { aoCodigo(await sock.requestPairingCode(numero)) } catch (e) { reject(e) }
        }
        if (u.connection === 'open') { encerrado = true; resolve(sock) }
        if (u.connection === 'close') {
          const cod = u.lastDisconnect?.error?.output?.statusCode
          if (cod === DisconnectReason.restartRequired) { log('reconectando (pedido do WhatsApp)'); abrir(); return }
          if (!encerrado) reject(Object.assign(new Error(`conexão fechada (${cod ?? '?'})`), { codigo: cod }))
          else sock.caiu = cod ?? true
        }
      })
    }
    abrir()
  })
}

// ------------------------------------------------------------------ mensagens recebidas
/** número de quem escreveu (só conversa individual; grupos, status e canais ficam de fora) */
function remetente(m) {
  const k = m.key ?? {}
  if (k.fromMe) return null
  const jid = [k.remoteJidAlt, k.senderPn, k.remoteJid].find((j) => typeof j === 'string' && j.endsWith('@s.whatsapp.net'))
  return jid ? jid.split('@')[0].split(':')[0] : null
}
function textoDe(m) {
  const g = m.message ?? {}
  const msg = g.ephemeralMessage?.message ?? g.viewOnceMessage?.message ?? g
  const t = msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? msg.documentMessage?.caption
    ?? msg.buttonsResponseMessage?.selectedDisplayText ?? msg.listResponseMessage?.title
  if (t) return String(t)
  if (msg.audioMessage) return '[áudio]'
  if (msg.imageMessage) return '[imagem]'
  if (msg.videoMessage) return '[vídeo]'
  if (msg.documentMessage) return '[documento]'
  if (msg.locationMessage) return '[localização]'
  if (msg.stickerMessage || msg.reactionMessage || msg.protocolMessage) return null
  return Object.keys(msg).length ? '[mensagem]' : null
}

// ------------------------------------------------------------------ tarefas
async function parearEmpresa(t) {
  const sessao = await sessaoDoBanco(t.empresa_id)
  await estado(t.empresa_id, { rodando_seg: 300 })
  log(`imobiliária ${t.empresa_id}: pareando`)
  try {
    const sock = await Promise.race([
      conectar(t.empresa_id, sessao, { parear: true, numero: t.numero, aoCodigo: (codigo) => { log(`imobiliária ${t.empresa_id}: código gerado`); estado(t.empresa_id, { codigo, rodando_seg: 300 }) } }),
      dormir(Math.min(4 * 60_000, restante())).then(() => { throw new Error('o código não foi digitado a tempo') }),
    ])
    await dormir(8000)
    await sessao.descarregar()
    const numero = (sock.user?.id ?? '').split(/[:@]/)[0] || t.numero
    await estado(t.empresa_id, { situacao: 'CONECTADO', numero, aviso: null, rodando_seg: 0 })
    log(`imobiliária ${t.empresa_id}: conectado`)
    sock.end(undefined)
  } catch (e) {
    await sessao.descarregar().catch(() => {})
    await estado(t.empresa_id, { situacao: 'DESCONECTADO', aviso: `Pareamento não concluído: ${e.message}. Peça um código novo.`, rodando_seg: 0 })
    log(`imobiliária ${t.empresa_id}: pareamento falhou: ${e.message}`)
  }
}

/** troca {pix} pelo copia e cola do valor do dia (ou some, sem chave Pix configurada) */
function comPix(texto, m, pix) {
  if (!texto.includes('{pix}')) return texto
  let codigo = null
  if (pix?.chave && m.pix_valor) { try { codigo = brCodePix({ chave: pix.chave, nome: pix.nome, cidade: pix.cidade, valor: Number(m.pix_valor), txid: m.pix_txid }) } catch { codigo = null } }
  return texto.replace('{pix}', codigo ? `\n\nPix copia e cola (valor de hoje):\n${codigo}\n` : '').replace(/[ \t]*\n[ \t]*/g, '\n').trim()
}

async function enviarEmpresa(t) {
  const sessao = await sessaoDoBanco(t.empresa_id)
  if (sessao.novo) { await estado(t.empresa_id, { situacao: 'DESCONECTADO', aviso: 'Sessão não encontrada: conecte o número de novo.', rodando_seg: 0 }); return }
  await estado(t.empresa_id, { rodando_seg: 120 })
  // recebidas: processadas em ordem, uma por vez
  let ultimaRecebida = 0, recebidas = 0, filaEntrada = Promise.resolve()
  const aoReceber = (m) => {
    const tel = remetente(m), texto = textoDe(m)
    const quando = Number(m.messageTimestamp ?? 0) * 1000
    if (!tel || !texto || (quando && Date.now() - quando > 2 * 86_400_000)) return
    ultimaRecebida = Date.now(); recebidas++
    filaEntrada = filaEntrada.then(() => rpc('whatsapp_entrada', { p_empresa: t.empresa_id, p_telefone: tel, p_nome: m.pushName ?? null, p_texto: texto.slice(0, 4000), p_mensagem_id: m.key?.id ?? null }))
      .catch((e) => log('entrada falhou:', e.message))
  }
  let sock
  try {
    sock = await Promise.race([conectar(t.empresa_id, sessao, { aoReceber: t.atendimento ? aoReceber : null }), dormir(90_000).then(() => { throw new Error('tempo esgotado ao conectar') })])
  } catch (e) {
    await sessao.descarregar().catch(() => {})
    if (e.codigo === DisconnectReason.loggedOut) await estado(t.empresa_id, { situacao: 'DESCONECTADO', aviso: 'O celular desconectou este aparelho (WhatsApp › Dispositivos conectados). Conecte de novo.', rodando_seg: 0 })
    else await estado(t.empresa_id, { aviso: `Não conectou: ${e.message}`, rodando_seg: 0 })
    log(`imobiliária ${t.empresa_id}: não conectou: ${e.message}`)
    return
  }
  log(`imobiliária ${t.empresa_id}: conectado, lote de até ${t.lote}, atendimento ${t.atendimento ? 'ligado' : 'desligado'}`)
  await dormir(8000)          // mensagens recebidas enquanto o robô estava fora chegam logo ao conectar
  await filaEntrada

  let n = 0
  const enviarUma = async (soAtendimento) => {
    await estado(t.empresa_id, { rodando_seg: 180 })
    const [m] = (await rpc('whatsapp_proximo', { p_empresa: t.empresa_id, p_so_atendimento: soAtendimento })) ?? []
    if (!m) return false
    try {
      const [conta] = (await sock.onWhatsApp(m.telefone)) ?? []
      if (!conta?.exists) { await rpc('whatsapp_marcar', { p_id: m.id, p_resultado: 'SEM_WHATSAPP' }); log(`#${m.id} sem WhatsApp`); return true }
      await sock.presenceSubscribe(conta.jid).catch(() => {})
      await sock.sendPresenceUpdate('composing', conta.jid).catch(() => {})
      await dormir(randomInt(2500, 6000))
      await sock.sendPresenceUpdate('paused', conta.jid).catch(() => {})
      const texto = comPix(m.texto, m, t.pix)
      const r = await sock.sendMessage(conta.jid, { text: texto })
      if (r?.key?.id) sock.enviadas.set(r.key.id, r.message)
      await rpc('whatsapp_marcar', { p_id: m.id, p_resultado: 'OK', p_mensagem_id: r?.key?.id ?? null, p_texto: texto })
      if (m.origem !== 'ATENDIMENTO' && m.origem !== 'TESTE') n++
      log(`#${m.id} enviada (${m.origem})`)
    } catch (e) {
      await rpc('whatsapp_marcar', { p_id: m.id, p_resultado: 'FALHA', p_erro: String(e?.message ?? e).slice(0, 300) }).catch(() => {})
      log(`#${m.id} falhou: ${e?.message ?? e}`)
    }
    return true
  }
  // fila: respostas do atendimento e testes sempre; o resto até o tamanho do lote
  while (restante() > 2 * 60_000 && !sock.caiu) {
    const teve = await enviarUma(n >= t.lote)
    if (!teve) break
    await dormir(n >= t.lote ? randomInt(3000, 7000) : randomInt(t.intervalo_min * 1000, t.intervalo_max * 1000 + 1))
  }
  // atendimento: fica ouvindo enquanto a conversa acontece (até 4 min depois da última mensagem; no mínimo 40 s)
  if (t.atendimento) {
    const inicioEspera = Date.now()
    const fim = () => Date.now() - Math.max(ultimaRecebida, inicioEspera) > (recebidas ? 4 * 60_000 : 40_000)
    while (!fim() && restante() > 90_000 && !sock.caiu) {
      await filaEntrada
      if (!(await enviarUma(true))) await dormir(3000)
    }
  }
  await filaEntrada
  await dormir(10_000)
  await sessao.descarregar()
  await estado(t.empresa_id, { rodando_seg: 0, ...(sock.caiu === DisconnectReason.loggedOut ? { situacao: 'DESCONECTADO', aviso: 'O celular desconectou este aparelho. Conecte de novo.' } : {}) })
  log(`imobiliária ${t.empresa_id}: ${n} do lote, ${recebidas} recebida(s)`)
  try { sock.end(undefined) } catch { /* já fechado */ }
}

// ------------------------------------------------------------------ principal
try {
  const tarefas = (await rpc('whatsapp_robo_trabalho', {})) ?? []
  log(`${tarefas.length} imobiliária(s) com trabalho`)
  await Promise.all(tarefas.map(async (t) => {
    try { await (t.modo === 'PAREAR' ? parearEmpresa(t) : enviarEmpresa(t)) }
    catch (e) { log(`imobiliária ${t.empresa_id}: erro: ${e.message}`); await estado(t.empresa_id, { rodando_seg: 0 }) }
  }))
} catch (e) {
  log('erro:', e.message); process.exitCode = 1
}
setTimeout(() => process.exit(), 2000)
