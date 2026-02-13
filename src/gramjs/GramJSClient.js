/**
 * GramJS Client Wrapper
 * Handles MTProto connection, login, session persistence, and message handling.
 */

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/index.js';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

export class GramJSClient {
  constructor(config) {
    this.apiId = parseInt(config.api_id);
    this.apiHash = config.api_hash;
    this.sessionFile = config.session_file || 'data/session.txt';
    this.whitelist = (config.whitelist || []).map(id => BigInt(id));
    this.groupMode = config.group_mode || 'mention_only';
    this.botUsername = null;
    this.client = null;
    this.messageHandler = null;
  }

  async connect() {
    // Load or create session
    let sessionStr = '';
    const sessionPath = path.resolve(this.sessionFile);
    if (fs.existsSync(sessionPath)) {
      sessionStr = fs.readFileSync(sessionPath, 'utf-8').trim();
      console.log('📂 Loaded saved session');
    }

    const session = new StringSession(sessionStr);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
    });

    // Interactive login
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));

    await this.client.start({
      phoneNumber: () => ask('📱 Phone number: '),
      password: () => ask('🔐 2FA Password: '),
      phoneCode: () => ask('💬 Login code: '),
      onError: (err) => console.error('❌ Login error:', err.message),
    });

    rl.close();

    // Save session
    const dir = path.dirname(sessionPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionPath, this.client.session.save());
    console.log('💾 Session saved to', this.sessionFile);

    // Get own info
    const me = await this.client.getMe();
    this.botUsername = me.username;
    console.log(`✅ Connected as @${this.botUsername} (${me.firstName})`);

    // Listen for group invites + incoming calls
    this.client.addEventHandler(async (update) => {
      try {
        await this._handleGroupInvite(update);
        await this._handleIncomingCall(update);
      } catch {}
    }, new Raw({}));

    return this;
  }

  async _handleGroupInvite(update) {
    // Detect being added to a chat/channel
    const className = update?.className;
    if (className !== 'UpdateNewMessage' && className !== 'UpdateNewChannelMessage') return;

    const msg = update.message;
    if (!msg || msg.className !== 'MessageService') return;

    const action = msg.action;
    if (!action) return;

    // Check if this is a "user added" action
    const isAddAction = action.className === 'MessageActionChatAddUser' ||
                        action.className === 'MessageActionChatJoinedByLink';

    if (!isAddAction) return;

    // Check if WE were added
    const me = await this.client.getMe();
    const myId = me.id;

    let weWereAdded = false;
    if (action.users) {
      weWereAdded = action.users.some(uid => uid.equals ? uid.equals(myId) : String(uid) === String(myId));
    } else if (action.className === 'MessageActionChatJoinedByLink') {
      weWereAdded = msg.fromId && String(msg.fromId.userId || msg.fromId) === String(myId);
    }

    if (!weWereAdded) return;

    // Check who invited us
    const inviterId = msg.fromId?.userId || msg.fromId;
    const chatId = msg.chatId || msg.peerId;

    if (this.whitelist.length > 0 && inviterId && !this.whitelist.includes(BigInt(inviterId))) {
      console.log(`🚪 Auto-leaving group ${chatId} — invited by non-whitelisted user ${inviterId}`);
      try {
        if (msg.peerId?.className === 'PeerChannel') {
          await this.client.invoke(new Api.channels.LeaveChannel({ channel: chatId }));
        } else {
          await this.client.invoke(new Api.messages.DeleteChatUser({ chatId, userId: myId }));
        }
        console.log(`✅ Left group ${chatId}`);
      } catch (err) {
        console.error(`❌ Failed to leave group: ${err.message}`);
      }
      return;
    }

    console.log(`✅ Joined group ${chatId} — invited by whitelisted user ${inviterId}`);
  }

  async _handleIncomingCall(update) {
    // Detect incoming phone call
    if (update?.className !== 'UpdatePhoneCall') return;

    const phoneCall = update.phoneCall;
    if (!phoneCall) return;

    // Only handle incoming/waiting calls
    const callClass = phoneCall.className;
    if (callClass !== 'PhoneCallRequested' && callClass !== 'PhoneCallWaiting') return;

    const callerId = phoneCall.participantId || phoneCall.adminId;
    console.log(`📞 Incoming call from ${callerId} — auto-rejecting`);

    try {
      // Acknowledge receipt first
      await this.client.invoke(new Api.phone.ReceivedCall({
        peer: new Api.InputPhoneCall({
          id: phoneCall.id,
          accessHash: phoneCall.accessHash,
        }),
      }));

      // Discard (reject) the call
      await this.client.invoke(new Api.phone.DiscardCall({
        peer: new Api.InputPhoneCall({
          id: phoneCall.id,
          accessHash: phoneCall.accessHash,
        }),
        duration: 0,
        reason: new Api.PhoneCallDiscardReasonBusy(),
        connectionId: BigInt(0),
      }));

      console.log(`✅ Call rejected from ${callerId}`);
    } catch (err) {
      console.error(`❌ Failed to reject call: ${err.message}`);
    }
  }

  onMessage(handler) {
    this.messageHandler = handler;
    this.client.addEventHandler(async (event) => {
      try {
        await this._handleEvent(event);
      } catch (err) {
        console.error('❌ Event handler error:', err.message);
      }
    }, new NewMessage({}));

    // Listen for edited messages via Raw handler
    this.client.addEventHandler(async (update) => {
      try {
        if (update.className !== 'UpdateEditMessage' && update.className !== 'UpdateEditChannelMessage') return;
        const msg = update.message;
        if (!msg || msg.out) return;
        // Wrap in a pseudo-event and handle like a normal message but with isEdit flag
        this._editFlag = true;
        await this._handleEvent({ message: msg });
        this._editFlag = false;
      } catch (err) {
        this._editFlag = false;
        console.error('❌ Edit handler error:', err.message);
      }
    }, new Raw({}));
  }

  async _handleEvent(event) {
    const msg = event.message;
    if (!msg || msg.out) return; // ignore own messages

    const chatId = msg.chatId || msg.peerId;
    const senderId = msg.senderId;
    const text = msg.text || '';

    // Handle voice messages
    let voicePath = null;
    if (msg.voice || (msg.media?.className === 'MessageMediaDocument' && msg.media?.document?.mimeType?.startsWith('audio/ogg'))) {
      try {
        const voiceDir = path.resolve('data/voices');
        if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });
        voicePath = path.join(voiceDir, `${Date.now()}_${msg.id}.ogg`);
        const buffer = await this.client.downloadMedia(msg, {});
        if (buffer) {
          fs.writeFileSync(voicePath, buffer);
          console.log(`🎤 Downloaded voice to ${voicePath}`);
        } else {
          voicePath = null;
        }
      } catch (err) {
        console.error(`❌ Voice download failed: ${err.message}`);
        voicePath = null;
      }
    }

    // Handle photo media
    let imagePath = null;
    if (msg.photo) {
      try {
        const imgDir = path.resolve('data/images');
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
        imagePath = path.join(imgDir, `${Date.now()}_${msg.id}.jpg`);
        const buffer = await this.client.downloadMedia(msg, {});
        if (buffer) {
          fs.writeFileSync(imagePath, buffer);
          console.log(`📷 Downloaded image to ${imagePath}`);
        } else {
          imagePath = null;
        }
      } catch (err) {
        console.error(`❌ Image download failed: ${err.message}`);
        imagePath = null;
      }
    }

    // Handle document/file media (non-photo, non-voice)
    let filePath = null;
    let fileName = null;
    const hasDocument = msg.document || (msg.media?.document && !msg.photo && !voicePath);
    if (hasDocument && !voicePath) {
      try {
        const doc = msg.media?.document || msg.document;
        const attrs = doc?.attributes || [];
        const fnAttr = attrs.find(a => a.className === 'DocumentAttributeFilename');
        fileName = fnAttr?.fileName || `file_${msg.id}`;
        const fileDir = path.resolve('data/files');
        if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
        filePath = path.join(fileDir, `${Date.now()}_${fileName}`);
        const buffer = await this.client.downloadMedia(msg, {});
        if (buffer) {
          fs.writeFileSync(filePath, buffer);
          console.log(`📎 Downloaded file: ${fileName} → ${filePath}`);
        } else {
          filePath = null; fileName = null;
        }
      } catch (err) {
        console.error(`❌ File download failed: ${err.message}`);
        filePath = null; fileName = null;
      }
    }

    if (!text && !imagePath && !voicePath && !filePath) return;

    // Determine chat type
    const chat = await msg.getChat();
    const isChannel = chat?.className === 'Channel' && chat?.broadcast;
    const isGroup = (chat?.className === 'Chat') ||
                    (chat?.className === 'Channel' && !chat?.broadcast);
    const isDM = !isGroup && !isChannel;

    // Channel: ignore
    if (isChannel) return;

    // DM: whitelist check
    if (isDM) {
      if (this.whitelist.length > 0 && !this.whitelist.includes(BigInt(senderId))) {
        console.log(`🚫 DM from non-whitelisted user ${senderId}`);
        return;
      }
    }

    // Group: check if mentioned/replied, pass flag for intent detection
    let isMentioned = false;
    let isReplyToMe = false;
    if (isGroup) {
      isMentioned = this.botUsername && text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`);
      isReplyToMe = msg.replyTo ? await this._isReplyToMe(msg) : false;

      // Whitelist check for group senders
      if (this.whitelist.length > 0 && !this.whitelist.includes(BigInt(senderId))) {
        // Non-whitelisted group members: only process if they mention/reply to us
        if (!isMentioned && !isReplyToMe) return;
      }
    }

    const sender = await msg.getSender();
    // Detect forwarded messages
    let isForward = false;
    let forwardFrom = null;
    if (msg.fwdFrom) {
      isForward = true;
      try {
        if (msg.fwdFrom.fromName) {
          forwardFrom = msg.fwdFrom.fromName;
        } else if (msg.fwdFrom.fromId) {
          const fwdSender = await this.client.getEntity(msg.fwdFrom.fromId);
          forwardFrom = fwdSender?.firstName || fwdSender?.title || fwdSender?.username || 'Unknown';
        }
      } catch {
        forwardFrom = 'Unknown';
      }
    }

    console.log(`📩 [${isDM ? 'DM' : 'Group'}]${isForward ? ' [FWD]' : ''} ${sender?.username || senderId}: ${text.substring(0, 80)}`);

    if (this.messageHandler) {
      await this.messageHandler({
        text: this.botUsername ? text.replace(new RegExp(`@${this.botUsername}`, 'gi'), '').trim() : text,
        rawText: text,
        senderId: senderId.toString(),
        senderName: sender?.firstName || sender?.username || 'Unknown',
        chatId: chatId.toString(),
        isDM,
        isGroup,
        isMentioned: isMentioned || isReplyToMe,
        isForward,
        forwardFrom,
        isEdit: !!this._editFlag,
        imagePath,
        voicePath,
        filePath,
        fileName,
        message: msg,
      });
    }
  }

  async _isReplyToMe(msg) {
    try {
      const replied = await msg.getReplyMessage();
      return replied?.out === true;
    } catch {
      return false;
    }
  }

  async setTyping(chatId) {
    try {
      await this.client.invoke(new Api.messages.SetTyping({
        peer: chatId,
        action: new Api.SendMessageTypingAction(),
      }));
    } catch {}
  }

  async clearChat(chatId) {
    try {
      // Get all messages in chat and delete them (our messages only for DM)
      let deleted = 0;
      let offsetId = 0;
      while (true) {
        const messages = await this.client.getMessages(chatId, {
          limit: 100,
          offsetId,
        });
        if (!messages || messages.length === 0) break;

        const ids = messages.map(m => m.id);
        try {
          await this.client.invoke(new Api.messages.DeleteMessages({
            id: ids,
            revoke: true,
          }));
        } catch {
          // Try channel delete if regular fails
          try {
            await this.client.invoke(new Api.channels.DeleteMessages({
              channel: chatId,
              id: ids,
            }));
          } catch {}
        }
        deleted += ids.length;
        offsetId = messages[messages.length - 1].id;
        if (messages.length < 100) break;
      }
      console.log(`🗑️ Cleared ${deleted} messages from ${chatId}`);
      return deleted;
    } catch (err) {
      console.error(`❌ Clear chat failed: ${err.message}`);
      return 0;
    }
  }

  async deleteMessage(chatId, messageId) {
    try {
      await this.client.invoke(new Api.messages.DeleteMessages({
        id: [messageId],
        revoke: true,
      }));
      console.log(`🗑️ Deleted sensitive message ${messageId}`);
    } catch (err) {
      console.error(`❌ Failed to delete message: ${err.message}`);
    }
  }

  async sendMessage(chatId, text, replyTo = null) {
    try {
      const params = { message: text };
      if (replyTo) params.replyTo = replyTo;
      await this.client.sendMessage(chatId, params);
      console.log(`📤 Sent response to ${chatId}`);
    } catch (err) {
      console.error(`❌ Failed to send to ${chatId}:`, err.message);
      // Handle flood wait
      if (err.seconds) {
        console.log(`⏳ Flood wait: ${err.seconds}s`);
        await new Promise(r => setTimeout(r, err.seconds * 1000 + 1000));
        await this.client.sendMessage(chatId, { message: text, replyTo });
      }
    }
  }

  async markAsRead(chatId, messageId) {
    try {
      await this.client.invoke(new Api.messages.ReadHistory({
        peer: chatId,
        maxId: messageId,
      }));
    } catch (err) {
      // Silently fail for channels (use ReadChannelHistory)
      try {
        await this.client.invoke(new Api.channels.ReadHistory({
          channel: chatId,
          maxId: messageId,
        }));
      } catch {}
    }
  }

  async sendFile(chatId, filePath, caption = '', replyTo = null) {
    try {
      const params = { file: filePath };
      if (caption) params.caption = caption;
      if (replyTo) params.replyTo = replyTo;
      await this.client.sendFile(chatId, params);
      console.log(`📤 Sent file to ${chatId}: ${path.basename(filePath)}`);
    } catch (err) {
      console.error(`❌ Failed to send file: ${err.message}`);
    }
  }

  async sendVoice(chatId, audioPath, replyTo = null) {
    try {
      const params = { file: audioPath, voiceNote: true };
      if (replyTo) params.replyTo = replyTo;
      await this.client.sendFile(chatId, params);
      console.log(`📤 Sent voice to ${chatId}`);
    } catch (err) {
      console.error(`❌ Failed to send voice: ${err.message}`);
    }
  }

  async editMessage(chatId, messageId, newText) {
    try {
      await this.client.invoke(new Api.messages.EditMessage({
        peer: chatId,
        id: messageId,
        message: newText,
      }));
    } catch (err) {
      console.error(`❌ Failed to edit message: ${err.message}`);
    }
  }

  async sendReaction(chatId, messageId, emoji) {
    try {
      await this.client.invoke(new Api.messages.SendReaction({
        peer: chatId,
        msgId: messageId,
        reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
      }));
    } catch (err) {
      console.error(`❌ Reaction failed: ${err.message}`);
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      console.log('🔌 Disconnected');
    }
  }
}
