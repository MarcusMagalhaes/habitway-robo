# HabitWay — robô do WhatsApp

Robô do WhatsApp do [HabitWay](https://habitway.com.br) (sistema de gestão imobiliária da OneWay): envia as mensagens da
fila de cada imobiliária (cobrança da régua com Pix, lembrete de visita, propostas) e faz o atendimento de quem escreve
(lead no CRM, menu do inquilino). Usa o [Baileys](https://github.com/WhiskeySockets/Baileys), cliente não oficial.

- Roda no GitHub Actions só quando há trabalho: o Worker do site pergunta ao banco e dispara o workflow.
- Não guarda nada aqui: a fila, as regras (horário, limites, aquecimento do número) e a sessão (cifrada com AES-GCM)
  ficam no banco do HabitWay, acessado só com a chave do serviço (segredo do repositório).
- O código não tem segredos e o log das rodadas não tem dados pessoais (só ids e contagens).

O código-fonte de referência fica no repositório privado do sistema (`whatsapp/robo`); este repositório é só a cópia
que roda (público para os minutos do Actions não terem limite).
