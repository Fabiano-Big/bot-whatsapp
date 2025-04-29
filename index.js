const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

let mensagensMarcar = {};
let mensagensAutomatica = "Seja bem-vindo(a) ao grupo! 🎉";
let gruposAtivados = {}; // Grupos onde o bot está ativado

let reconnectAttempts = 0;

const estadoGruposPath = './estadoGrupos.json';

// Carregar estado de ativação dos grupos do arquivo
function carregarEstadoGrupos() {
  if (fs.existsSync(estadoGruposPath)) {
    const dados = fs.readFileSync(estadoGruposPath);
    try {
      gruposAtivados = JSON.parse(dados);
    } catch (err) {
      console.error("Erro ao carregar o estado dos grupos:", err);
    }
  }
}

// Salvar estado de ativação dos grupos no arquivo
function salvarEstadoGrupos() {
  fs.writeFileSync(estadoGruposPath, JSON.stringify(gruposAtivados, null, 2));
}

async function getGroupMetadataWithRetry(sock, groupId, retries = 3, timeout = 15000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout));
      const metadata = await Promise.race([sock.groupMetadata(groupId), timeoutPromise]);
      return metadata;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`Erro ao obter metadata do grupo ${groupId}, tentativa ${attempt}/${retries}`);
      } else {
        console.error(`❌ Falha ao recuperar metadata após ${retries} tentativas para o grupo ${groupId}`);
        return null;
      }
    }
  }
}

async function isBotAdmin(sock, groupId) {
  const metadata = await getGroupMetadataWithRetry(sock, groupId);
  if (!metadata) return false;
  const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  return metadata.participants.some(p => p.id === botNumber && (p.admin === 'admin' || p.admin === 'superadmin'));
}

function isSessionActive(sock) {
  return sock.ws.readyState === sock.ws.OPEN;
}

async function startBot() {
  console.log("Iniciando o bot...");

  // Carregar o estado dos grupos
  carregarEstadoGrupos();

  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
    }
  });

  const store = makeInMemoryStore({ logger: P({ level: 'silent' }) });
  store.bind(sock.ev);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão encerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect && reconnectAttempts < 5) {
        reconnectAttempts++;
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('Número máximo de reconexões atingido.');
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado!');
      reconnectAttempts = 0;
    } else if (qr) {
      qrcode.generate(qr, { small: true });
    }
  });

  sock.ev.on('messages.upsert', async (msg) => {
    const m = msg.messages[0];
    if (!m.message) return;

    const texto = m.message.conversation || m.message.extendedTextMessage?.text || '';
    const sender = m.key.participant || m.key.remoteJid;
    const isGroup = m.key.remoteJid.endsWith('@g.us');
    const groupId = m.key.remoteJid;

    if (!isSessionActive(sock)) return;

    const metadata = await getGroupMetadataWithRetry(sock, groupId);
    if (!metadata) return;
    if (!isGroup) return;

    // Se o grupo não estiver ativado e o comando não for !ativarbot, o bot ignora
    if (!gruposAtivados[groupId] && !texto.startsWith('!ativarbot')) {
      return;
    }

    const isSenderAdmin = metadata.participants.some(p => p.id === sender && (p.admin === 'admin' || p.admin === 'superadmin'));
    const isBotAdminGroup = await isBotAdmin(sock, groupId);

    if (!isBotAdminGroup && texto.startsWith('!')) return;

    if (!isSenderAdmin && texto.startsWith('!')) {
      return sock.sendMessage(groupId, { text: '🚫 Você precisa ser admin para usar este comando!' });
    }

    // Comando: !ativarbot
    if (texto.startsWith('!ativarbot')) {
      const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';

      if (sender !== botNumber) {
        return sock.sendMessage(groupId, { text: '🚫 Apenas o proprietário do bot pode ativar o bot neste grupo.' });
      }

      gruposAtivados[groupId] = true;
      salvarEstadoGrupos(); // Salvar estado
      return sock.sendMessage(groupId, { text: '✅ Bot ativado neste grupo!' });
    }

    // Comando: !desativarbot
    if (texto.startsWith('!desativarbot')) {
      const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';

      if (sender !== botNumber) {
        return sock.sendMessage(groupId, { text: '🚫 Apenas o proprietário do bot pode desativar o bot neste grupo.' });
      }

      gruposAtivados[groupId] = false;
      salvarEstadoGrupos(); // Salvar estado
      return sock.sendMessage(groupId, { text: '❌ Bot desativado neste grupo.' });
    }

    // Comando: !marcar
    if (texto.startsWith('!marcar')) {
      if (!isGroup) return sock.sendMessage(sender, { text: '❌ Este comando só funciona em grupos!' });

      const members = metadata.participants.map(p => p.id);
      const mensagemParaMarcar = mensagensMarcar[groupId] || "📢 Atenção, todos os participantes! ⬇️";

      if (members.length === 0) {
        return sock.sendMessage(groupId, { text: '🚫 Nenhum participante encontrado no grupo.' });
      }

      return sock.sendMessage(groupId, {
        text: mensagemParaMarcar,
        mentions: members
      });
    }

    // Comando: !mensagemmarcar
    if (texto.startsWith('!mensagemmarcar')) {
      const novaMensagem = texto.split(' ').slice(1).join(' ');
      if (!novaMensagem) {
        return sock.sendMessage(groupId, { text: '🚫 Forneça a nova mensagem para o comando !marcar.' });
      }

      mensagensMarcar[groupId] = novaMensagem;
      return sock.sendMessage(groupId, { text: `✅ Mensagem do *!marcar* atualizada para:\n\n"${novaMensagem}"` });
    }

    // Comando: !sorteio
    if (texto.startsWith('!sorteio')) {
      const participantes = metadata.participants
        .filter(p => p.id !== sock.user.id)
        .map(p => p.id);

      if (participantes.length === 0) {
        return sock.sendMessage(groupId, { text: '🚫 Nenhum participante elegível para o sorteio.' });
      }

      const sorteado = participantes[Math.floor(Math.random() * participantes.length)];
      return sock.sendMessage(groupId, {
        text: `🎉 Parabéns @${sorteado.split('@')[0]}! Você foi o(a) sorteado(a)!`,
        mentions: [sorteado]
      });
    }

    // Comando: !comandos
    if (texto.startsWith('!comandos')) {
      const comandos = `
💬 *Comandos disponíveis:*

1️⃣ *!marcar* - Marca todos os participantes do grupo. 📣  
2️⃣ *!mensagemmarcar* - Altera a mensagem usada no comando !marcar. ✏️  
3️⃣ *!ban* - Banir um participante do grupo. 🚫  
4️⃣ *!sorteio* - Realizar um sorteio entre os participantes. 🎉  
5️⃣ *!mensagem* - Configura a mensagem automática do grupo. 📝  
6️⃣ *!promover* - Promove um membro a administrador. 🛡️  
7️⃣ *!apagar* - Apaga uma mensagem para todos. 🗑️  
8️⃣ *!fechar* - Fecha o grupo para mensagens. 🔒  
9️⃣ *!abrir* - Abre o grupo para mensagens. 🔓  

*Teste agora e divirta-se! 😎*
      `;
      return sock.sendMessage(groupId, { text: comandos });
    }

    // Comando: !ban
    if (texto.startsWith('!ban')) {
      const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mentioned) return sock.sendMessage(groupId, { text: '🚫 Marque alguém para banir.' });

      try {
        await sock.groupParticipantsUpdate(groupId, [mentioned], 'remove');
        return sock.sendMessage(groupId, { text: '✅ Usuário removido com sucesso.' });
      } catch (err) {
        return sock.sendMessage(groupId, { text: '❌ Erro ao tentar remover.' });
      }
    }

    // Comando: !promover
    if (texto.startsWith('!promover')) {
      const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mentioned) return sock.sendMessage(groupId, { text: '🚫 Marque alguém para promover.' });

      try {
        await sock.groupParticipantsUpdate(groupId, [mentioned], 'promote');
        return sock.sendMessage(groupId, { text: '✅ Usuário promovido com sucesso.' });
      } catch (err) {
        return sock.sendMessage(groupId, { text: '❌ Erro ao tentar promover.' });
      }
    }

    // Comando: !mensagem
    if (texto.startsWith('!mensagem')) {
      const novaMensagem = texto.split(' ').slice(1).join(' ');
      if (!novaMensagem) return sock.sendMessage(groupId, { text: '🚫 Forneça uma nova mensagem!' });

      mensagensAutomatica = novaMensagem;
      return sock.sendMessage(groupId, { text: `✅ Mensagem automática definida como:\n"${mensagensAutomatica}"` });
    }

    // Comando: !apagar
    if (texto.startsWith('!apagar')) {
      const quoted = m.message?.extendedTextMessage?.contextInfo;

      if (!quoted?.stanzaId || !quoted?.participant) {
        await sock.sendMessage(groupId, { text: '🚫 Você precisa *responder* a mensagem que deseja apagar usando *!apagar*!' });
        return;
      }

      try {
        await sock.sendMessage(groupId, {
          delete: {
            remoteJid: groupId,
            fromMe: false, // tenta apagar mesmo não sendo do bot
            id: quoted.stanzaId,
            participant: quoted.participant
          }
        });
      } catch (err) {
        console.error('Erro ao apagar mensagem:', err);
        await sock.sendMessage(groupId, { text: '❌ Erro ao tentar apagar. Talvez o bot não tenha permissão suficiente.' });
      }
    }

    // Comando: !fechar
    if (texto.startsWith('!fechar')) {
      await sock.groupSettingUpdate(groupId, 'announcement');
      return sock.sendMessage(groupId, { text: '🔒 Grupo fechado para mensagens!' });
    }

    // Comando: !abrir
    if (texto.startsWith('!abrir')) {
      await sock.groupSettingUpdate(groupId, 'not_announcement');
      return sock.sendMessage(groupId, { text: '🔓 Grupo aberto para mensagens!' });
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    const metadata = await getGroupMetadataWithRetry(sock, update.id);
    if (!metadata) return;

    const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const isBotAdmin = metadata.participants.some(p => p.id === botNumber && (p.admin === 'admin' || p.admin === 'superadmin'));

    if (update.action === 'add' && gruposAtivados[update.id]) {
      for (const participant of update.participants) {
        await sock.sendMessage(update.id, {
          text: `${mensagensAutomatica}\n👋 Olá @${participant.split('@')[0]}, seja bem-vindo(a) ao grupo *${metadata.subject}*!`,
          mentions: [participant]
        });
      }
    }
  });
}

startBot().catch((err) => console.log('Erro ao iniciar o bot:', err));
