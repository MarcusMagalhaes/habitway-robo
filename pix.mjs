// Pix copia e cola (BR Code) para o robô: cópia de src/lib/pix.ts (mesma regra; o teste whatsapp/robo/pix.test.ts confere
// que os dois dão o mesmo código). O robô roda sozinho no GitHub Actions, sem as dependências do app.
const campo = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`
export function crc16(s) {
  let crc = 0xffff
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}
const limpo = (s, max) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .,\-/&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
function cpfValido(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false
  const dv = (k) => { let s = 0; for (let i = 0; i < k; i++) s += Number(d[i]) * (k + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r }
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10])
}
export function normalizarChave(chave) {
  const c = (chave ?? '').trim()
  if (!c) return null
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c)) return c.toLowerCase()
  if (c.includes('@')) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c) ? c.toLowerCase() : null
  const d = c.replace(/\D/g, '')
  if (c.startsWith('+')) return d.length >= 12 && d.length <= 13 ? `+${d}` : null
  if (d.length === 14) return d
  if (d.length === 11 && !/[()]/.test(c) && (/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(c) || cpfValido(d))) return d
  if (d.length === 10 || d.length === 11) return `+55${d}`
  return null
}
export function brCodePix(d) {
  const ch = normalizarChave(d.chave)
  if (!ch) throw new Error('Chave Pix inválida')
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', ch)
  const txid = (d.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***'
  const corpo = campo('00', '01') + campo('26', conta) + campo('52', '0000') + campo('53', '986')
    + (d.valor && d.valor > 0 ? campo('54', d.valor.toFixed(2)) : '')
    + campo('58', 'BR') + campo('59', limpo(d.nome, 25) || 'RECEBEDOR') + campo('60', limpo(d.cidade, 15) || 'BRASIL')
    + campo('62', campo('05', txid)) + '6304'
  return corpo + crc16(corpo)
}
