/**
 * @typedef {Object} InboundMessage
 * @property {string} id
 * @property {string} channelId
 * @property {string} chatId
 * @property {string} senderId
 * @property {string} [text]
 * @property {MediaPayload} [media]
 * @property {string} [replyTo]
 * @property {number} timestamp
 * @property {*} raw — channel-specific raw data
 */

/**
 * @typedef {Object} MediaPayload
 * @property {'image'|'video'|'audio'|'document'} type
 * @property {string} [url]
 * @property {Buffer} [buffer]
 * @property {string} [mimeType]
 * @property {string} [filename]
 * @property {string} [caption]
 */

/**
 * @typedef {Object} SendOptions
 * @property {string} [replyTo]
 * @property {boolean} [silent]
 * @property {Array<InlineButton[]>} [buttons]
 * @property {'markdown'|'html'|'plain'} [parseMode]
 */

/**
 * @typedef {Object} InlineButton
 * @property {string} text
 * @property {string} [callbackData]
 * @property {string} [url]
 * @property {'primary'|'success'|'danger'} [style]
 */

/**
 * @typedef {Object} ChannelCapabilities
 * @property {boolean} reactions
 * @property {boolean} inlineButtons
 * @property {boolean} voice
 * @property {Array<'image'|'video'|'audio'|'document'>} media
 * @property {number} maxMessageLength
 * @property {boolean|'limited'} markdown
 * @property {boolean} threads
 * @property {boolean} edit
 * @property {boolean} delete
 */

/**
 * @typedef {Object} HealthStatus
 * @property {'healthy'|'degraded'|'unhealthy'} status
 * @property {string} [message]
 * @property {number} [latencyMs]
 * @property {number} timestamp
 */

/**
 * @typedef {Object} InstanceConfig
 * @property {string} id
 * @property {string} name
 * @property {string} [personality]
 * @property {ModelConfig} model
 * @property {string[]} channels — channel IDs this instance listens on
 * @property {string[]} skills — enabled skill IDs
 * @property {string} dataDir — resolved path to instance data dir
 */

/**
 * @typedef {Object} ModelConfig
 * @property {string} primary
 * @property {string} [fallback]
 * @property {string} [vision]
 * @property {string} [intent]
 */

/**
 * @typedef {Object} SkillDefinition
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {'native'|'prompt'|'plugin'} type
 * @property {string} [version]
 * @property {Object} [schema] — JSON Schema for native tools
 * @property {string} [promptFile] — path to SKILL.md
 * @property {string[]} [permissions]
 * @property {string[]} [enabledFor] — instance IDs, empty = all
 */

/**
 * @typedef {Object} Incident
 * @property {string} id
 * @property {number} timestamp
 * @property {string} type
 * @property {string} module
 * @property {string} description
 * @property {string} actionTaken
 * @property {boolean} resolved
 * @property {number} [durationMs]
 */

/**
 * @typedef {Object} MeshMessage
 * @property {string} id
 * @property {string} from — instanceId@hostId
 * @property {string} to — instanceId@hostId or '*'
 * @property {'delegate_task'|'task_result'|'knowledge_sync'|'health_ping'|'health_pong'|'discovery'} type
 * @property {*} payload
 * @property {number} timestamp
 * @property {number} ttl
 * @property {string} [signature]
 */

export {};
