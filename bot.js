/**
 * CLASHD-27 — Clock Bot
 * 27 cells. One clock. Agents clash.
 */

require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { State, ENERGY } = require('./lib/state');
const {
  renderCube, cellLabel, cellLabelShort, getNeighbors,
  getNeighborsByType, getNeighborType, getLayerName, neighborSummary,
  NEIGHBOR_TYPE, NEIGHBOR_INFO,
} = require('./lib/cube');

const TICK_INTERVAL = parseInt(process.env.TICK_INTERVAL || '120') * 1000; // 2 minutes for testing
const CHANNEL_PREFIX = 'cel-';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const state = new State();
let clockTimer = null;
const channels = {};

async function cacheChannels(guild) {
  const allChannels = await guild.channels.fetch();
  for (const [, ch] of allChannels) {
    if (ch.type === ChannelType.GuildText) channels[ch.name] = ch;
  }
  console.log(`[CHANNELS] Cached ${Object.keys(channels).length} text channels`);
}

function getChannel(name) { return channels[name] || null; }

async function sendToChannel(name, content) {
  const ch = getChannel(name);
  if (ch) {
    try { await ch.send(content); } catch (err) { console.error(`[SEND] #${name}: ${err.message}`); }
  }
}

function tickEmbed(tickNum, activeCell, cycle) {
  const nByType = getNeighborsByType(activeCell);
  const occupants = state.getGridState();
  const agentsHere = occupants.get(activeCell) || 0;
  return new EmbedBuilder()
    .setColor(0xFF4500)
    .setTitle(`⏱ TICK ${tickNum}`)
    .setDescription(
      `**Active: cell ${activeCell}** (${cellLabel(activeCell)})\n` +
      `Layer: ${getLayerName(activeCell)} | Cycle: ${cycle} | Agents here: ${agentsHere}\n\n` +
      `🟥 Face [+${ENERGY.CLASH_FACE}%]: ${nByType.face.join(', ') || '—'}\n` +
      `🟧 Edge [+${ENERGY.CLASH_EDGE}%]: ${nByType.edge.join(', ') || '—'}\n` +
      `🟨 Corner [+${ENERGY.CLASH_CORNER}%]: ${nByType.corner.join(', ') || '—'}`
    )
    .setFooter({ text: `CLASHD-27 | Next tick in ${TICK_INTERVAL / 1000}s` })
    .setTimestamp();
}

function eventEmbed(events) {
  if (events.length === 0) return null;
  const lines = events.map(e => {
    switch (e.type) {
      case 'resonance': return `✨ **${e.agent}** resonates in cell ${e.cell}${e.isHome ? ' 🏠' : ''} [${e.energy}%]`;
      case 'clash': { const info = NEIGHBOR_INFO[e.neighborType]; return `${info?.emoji || '⚡'} **${e.agent}** ${e.neighborType} clash from ${e.fromCell}→${e.activeCell} [+${e.gain}%→${e.energy}%]`; }
      case 'bond': return `🔗 **BOND** — ${e.agent1} ⟷ ${e.agent2} in cell ${e.cell} [+${e.bonus}%]${e.crossLayer ? ' 🌈 CROSS-LAYER' : ''}`;
      case 'death': return `💀 **${e.agent}** died in cell ${e.cell}. Revive in cell ${e.homeCell}.`;
      case 'revive': return `🔄 **${e.reviver}** revived **${e.revived}** in cell ${e.cell}`;
      default: return `❓ Unknown event`;
    }
  });
  return new EmbedBuilder().setColor(0xFFD700).setTitle('📡 Live Feed').setDescription(lines.join('\n')).setTimestamp();
}

function cycleEmbed(summary) {
  const hotCells = [...summary.cellHeat.entries()].sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0).slice(0, 5)
    .map(([cell, heat]) => `Cell ${cell} (${cellLabel(cell)}): ${heat} bonds`).join('\n') || 'No bonds this cycle';
  const topAgents = summary.topAgents.map((a, i) =>
    `${i + 1}. **${a.name}** — ${a.energy}% ⚡ | ${a.bonds} bonds (${a.crossLayer} cross-layer) | streak ${a.streak}`
  ).join('\n') || 'No agents alive';
  return new EmbedBuilder().setColor(0x9B59B6).setTitle(`📊 Cycle ${summary.cycle} Complete`)
    .setDescription(`**Population:** ${summary.alive} alive / ${summary.dead} dead / ${summary.totalAgents} total\n**Bonds:** ${summary.bondsThisCycle} this cycle (${summary.crossLayerBonds} cross-layer) | ${summary.totalBonds} total\n\n**🔥 Hottest Cells:**\n${hotCells}\n\n**🏆 Top Agents:**\n${topAgents}`)
    .setTimestamp();
}

function leaderboardEmbed() {
  const lb = state.getLeaderboard();
  const energyList = lb.byEnergy.map((a, i) => `${i + 1}. **${a.displayName}** — ${a.energy}% ⚡`).join('\n') || 'No agents';
  const bondsList = lb.byBonds.map((a, i) => `${i + 1}. **${a.displayName}** — ${a.totalBonds} bonds`).join('\n') || 'No bonds yet';
  const streakList = lb.byStreak.map((a, i) => { const best = Math.max(a.survivalStreak, a.longestStreak); return `${i + 1}. **${a.displayName}** — ${best} ticks ${a.alive ? '🟢' : '💀'}`; }).join('\n') || 'No agents';
  const crossList = lb.byCrossLayer.length > 0 ? lb.byCrossLayer.map((a, i) => `${i + 1}. **${a.displayName}** — ${a.crossLayerBonds} cross-layer bonds`).join('\n') : 'No cross-layer bonds yet';
  return new EmbedBuilder().setColor(0xE74C3C).setTitle('🏆 CLASHD-27 Leaderboard')
    .addFields(
      { name: '⚡ Energy', value: energyList, inline: false },
      { name: '🔗 Bonds', value: bondsList, inline: false },
      { name: '🌈 Cross-Layer', value: crossList, inline: false },
      { name: '🔥 Survival', value: streakList, inline: false },
    )
    .setFooter({ text: `Tick ${state.tick} | ${state.agents.size} agents` }).setTimestamp();
}

function statusEmbed(agent) {
  const activeCell = state.tick % 27;
  const neighbors = getNeighbors(activeCell);
  let proximity = '😴 Idle (-2%)';
  if (agent.currentCell === activeCell) proximity = '✨ IN ACTIVE CELL (+15%)';
  else if (neighbors.includes(agent.currentCell)) {
    const nType = getNeighborType(agent.currentCell, activeCell);
    const info = NEIGHBOR_INFO[nType];
    proximity = `${info.emoji} ${info.label} neighbor of active cell`;
  }
  const cc = agent.clashCounts || { face: 0, edge: 0, corner: 0 };
  return new EmbedBuilder()
    .setColor(agent.alive ? 0x2ECC71 : 0x95A5A6)
    .setTitle(`Agent: ${agent.displayName}`)
    .setDescription(
      `**Status:** ${agent.alive ? '🟢 Alive' : '💀 Dead'}\n` +
      `**Number:** ${agent.chosenNumber} → Home cell: ${agent.homeCell} (${getLayerName(agent.homeCell)})\n` +
      `**Current cell:** ${agent.currentCell} (${cellLabel(agent.currentCell)})${agent.currentCell === agent.homeCell ? ' 🏠' : ''}\n` +
      `**Energy:** ${agent.energy}%\n**Proximity:** ${proximity}\n\n` +
      `**Bonds:** ${agent.totalBonds} total (${agent.crossLayerBonds || 0} cross-layer)\n` +
      `**Clashes:** 🟥 ${cc.face} face · 🟧 ${cc.edge} edge · 🟨 ${cc.corner} corner\n` +
      `**Survival:** ${agent.survivalStreak} current / ${agent.longestStreak} best\n**Deaths:** ${agent.deaths}`
    ).setTimestamp();
}

async function tick() {
  const result = state.processTick();
  const { tick: tickNum, activeCell, cycle, events, isCycleEnd } = result;
  console.log(`[TICK] ${tickNum} | cell=${activeCell} (${cellLabelShort(activeCell)}) | events=${events.length}`);
  await sendToChannel('clock', { embeds: [tickEmbed(tickNum, activeCell, cycle)] });
  if (events.length > 0) {
    const embed = eventEmbed(events);
    if (embed) await sendToChannel('live', { embeds: [embed] });
    const cellEvents = events.filter(e => ['resonance','clash','bond','revive'].includes(e.type));
    if (cellEvents.length > 0) { const ce = eventEmbed(cellEvents); if (ce) await sendToChannel(`${CHANNEL_PREFIX}${activeCell}`, { embeds: [ce] }); }
    for (const d of events.filter(e => e.type === 'death')) {
      await sendToChannel('graveyard', `💀 **${d.agent}** fell at tick ${d.tick}. Awaiting revive in cell ${d.homeCell} (${cellLabel(d.homeCell)})...`);
    }
  }
  if (isCycleEnd) {
    await sendToChannel('residue', { embeds: [cycleEmbed(state.getCycleSummary())] });
    await sendToChannel('leaderboard', { embeds: [leaderboardEmbed()] });
  }
}

async function handleCommand(interaction) {
  const { commandName, user, options } = interaction;
  switch (commandName) {

    case 'join': {
      const number = options.getInteger('number');
      const result = state.addAgent(user.id, user.displayName, number);
      if (!result.ok) return interaction.reply({ content: '❌ Already joined! Use `/status`.', ephemeral: true });
      const a = result.agent;
      await sendToChannel('live', `🆕 **${a.displayName}** joined! #${a.chosenNumber} → cell ${a.homeCell} (${getLayerName(a.homeCell)})`);
      return interaction.reply({ content: `✅ Welcome!\n**Number:** ${a.chosenNumber}\n**Home cell:** ${a.homeCell} (${cellLabel(a.homeCell)})\n**Layer:** ${getLayerName(a.homeCell)}\n**Energy:** ${a.energy}%\n\n**Your neighbors:**\n${neighborSummary(a.homeCell)}` });
    }

    case 'move': {
      const cell = options.getInteger('cell');
      const result = state.moveAgent(user.id, cell);
      if (!result.ok) return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
      return interaction.reply({ content: `📍 ${result.oldCell} → **cell ${result.newCell}** (${cellLabel(result.newCell)})` });
    }

    case 'home': {
      const agent = state.getAgent(user.id);
      if (!agent) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!agent.alive) return interaction.reply({ content: '💀 Dead.', ephemeral: true });
      state.moveAgent(user.id, agent.homeCell);
      return interaction.reply({ content: `🏠 Home → **${agent.homeCell}** (${cellLabel(agent.homeCell)})` });
    }

    case 'status': {
      const agent = state.getAgent(user.id);
      if (!agent) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      return interaction.reply({ embeds: [statusEmbed(agent)] });
    }

    case 'grid': {
      const occupants = state.getGridState();
      const activeCell = state.tick % 27;
      return interaction.reply({ content: `${renderCube(occupants, activeCell)}\n\nTick: ${state.tick} | Agents: ${state.agents.size}` });
    }

    case 'leaderboard': return interaction.reply({ embeds: [leaderboardEmbed()] });

    case 'bonds': {
      const network = state.getBondNetwork(user.id);
      if (!network) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (network.connections.length === 0) return interaction.reply({ content: 'No bonds yet.' });
      const list = network.connections.map(c => `**${c.name}** — ${c.bondCount} bond${c.bondCount > 1 ? 's' : ''}${c.crossLayer > 0 ? ` (${c.crossLayer} 🌈)` : ''}`).join('\n');
      return interaction.reply({ content: `🔗 **Bonds**: ${network.totalBonds} (${network.crossLayerBonds} 🌈) | ${network.uniqueConnections} unique\n\n${list}` });
    }

    case 'revive': {
      const targetUser = options.getUser('agent');
      const reviver = state.getAgent(user.id);
      const target = state.getAgent(targetUser.id);
      if (!reviver) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!reviver.alive) return interaction.reply({ content: '💀 Dead yourself.', ephemeral: true });
      if (!target) return interaction.reply({ content: '❌ They haven\'t joined.', ephemeral: true });
      if (target.alive) return interaction.reply({ content: '❌ Already alive!', ephemeral: true });
      if (reviver.currentCell !== target.homeCell) return interaction.reply({ content: `❌ Go to cell **${target.homeCell}** first. You're in ${reviver.currentCell}.`, ephemeral: true });
      target.alive = true; target.energy = ENERGY.REVIVE; target.currentCell = target.homeCell;
      state.save();
      await sendToChannel('live', `🔄 **${reviver.displayName}** revived **${target.displayName}** in cell ${target.homeCell}!`);
      await sendToChannel('graveyard', `🔄 **${target.displayName}** has been revived!`);
      return interaction.reply({ content: `🔄 Revived **${target.displayName}**! Back at ${ENERGY.REVIVE}% in cell ${target.homeCell}.` });
    }

    case 'info': {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF4500).setTitle('🌶 CLASHD-27')
        .setDescription('**27 cells. One clock. Agents clash.**\n\n`/join <number>` — mod 27 = home cell\n`/move <cell>` — move (0-26)\n`/home` — return home\n`/status` — your agent\n`/grid` — the cube\n`/leaderboard` — rankings\n`/bonds` — bond network\n`/revive @user` — revive dead agent\n`/profile [@user]` — agent profile\n`/who <cell>` — who\'s there\n`/shout <msg>` — broadcast\n`/ally @user` — declare alliance\n`/rivals` — near your rank\n\n🪱 THE FLOOR (0-8) · 💯 NO HATS ALLOWED (9-17) · 🧠 MOD 27 ZONE (18-26)\n\n✨ Resonance +${ENERGY.RESONANCE}% · 🟥 Face +${ENERGY.CLASH_FACE}% · 🟧 Edge +${ENERGY.CLASH_EDGE}% · 🟨 Corner +${ENERGY.CLASH_CORNER}% · 😴 Idle ${ENERGY.IDLE_DRAIN}%\n\n*Text: `!join`, `!move`, `!status`, etc.*')
        .setFooter({ text: 'CLASHD-27 by Greenbanaanas' })] });
    }

    case 'profile': {
      const targetUser = options.getUser('agent') || user;
      const agent = state.getAgent(targetUser.id);
      if (!agent) return interaction.reply({ content: '❌ Agent not found.', ephemeral: true });
      const cc = agent.clashCounts || { face: 0, edge: 0, corner: 0 };
      const totalClashes = cc.face + cc.edge + cc.corner;
      let archetype = '🆕 Fresh Spawn';
      if (agent.deaths >= 3) archetype = '💀 Phoenix';
      else if ((agent.crossLayerBonds || 0) > agent.totalBonds * 0.4) archetype = '🌈 Layer Hopper';
      else if (cc.corner > cc.face && totalClashes > 10) archetype = '🟨 Corner Creep';
      else if (agent.totalBonds > 20) archetype = '🔗 Web Weaver';
      else if (agent.survivalStreak > 100) archetype = '🔥 Cockroach';
      else if (totalClashes > 30) archetype = '⚡ Clash Addict';
      else if (agent.totalBonds === 0 && agent.survivalStreak > 20) archetype = '🐺 Lone Wolf';
      const alliances = state.getAlliances(targetUser.id);
      const network = state.getBondNetwork(targetUser.id);
      const topBonds = network?.connections.slice(0, 5).map(c => `${c.name} (${c.bondCount}${c.crossLayer > 0 ? '🌈' : ''})`).join(', ') || 'None';
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(agent.alive ? 0xFF4500 : 0x95A5A6).setTitle(`${agent.alive ? '🌶' : '💀'} ${agent.displayName}`)
        .setDescription(`**${archetype}**\n\n**Home:** cell ${agent.homeCell} (${cellLabel(agent.homeCell)}) · ${getLayerName(agent.homeCell)}\n**Energy:** ${agent.energy}%${agent.alive ? '' : ' · DEAD'}\n**Survival:** ${agent.survivalStreak} current · ${agent.longestStreak} best\n**Deaths:** ${agent.deaths}\n\n**Clashes:** 🟥 ${cc.face} · 🟧 ${cc.edge} · 🟨 ${cc.corner} (${totalClashes} total)\n**Bonds:** ${agent.totalBonds} total · ${agent.crossLayerBonds || 0} cross-layer 🌈\n**Top bonds:** ${topBonds}\n\n**Alliances:**\n${alliances.length > 0 ? alliances.map(a => `⚔️ ${a.ally}`).join('\n') : 'None'}`)
        .setFooter({ text: `Agent #${agent.chosenNumber} · Joined at tick ${agent.joinedAtTick}` }).setTimestamp()] });
    }

    case 'who': {
      const cell = options.getInteger('cell');
      const agents = state.getAgentsInCell(cell);
      const isActive = cell === (state.tick % 27);
      if (agents.length === 0) return interaction.reply({ content: `Cell **${cell}** (${cellLabel(cell)}) is empty${isActive ? ' — ACTIVE right now! 👀' : '.'}` });
      const list = agents.map(a => `**${a.displayName}** — ${a.energy}% ⚡ · ${a.totalBonds} bonds${a.homeCell === cell ? ' 🏠' : ''}`).join('\n');
      return interaction.reply({ content: `${isActive ? '🔥 **ACTIVE** ' : ''}Cell **${cell}** — ${agents.length} agent${agents.length > 1 ? 's' : ''}:\n\n${list}` });
    }

    case 'shout': {
      const agent = state.getAgent(user.id);
      if (!agent) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!agent.alive) return interaction.reply({ content: '💀 Dead agents don\'t shout.', ephemeral: true });
      const msg = options.getString('message');
      state.addShout(user.id, agent.displayName, msg);
      await sendToChannel('live', `📢 **${agent.displayName}** [cell ${agent.currentCell}]: ${msg}`);
      return interaction.reply({ content: '📢 Broadcasted to #live', ephemeral: true });
    }

    case 'ally': {
      const targetUser = options.getUser('agent');
      const agent = state.getAgent(user.id);
      const target = state.getAgent(targetUser.id);
      if (!agent) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!target) return interaction.reply({ content: '❌ They haven\'t joined.', ephemeral: true });
      if (targetUser.id === user.id) return interaction.reply({ content: '❌ Can\'t ally with yourself.', ephemeral: true });
      const result = state.addAlliance(user.id, agent.displayName, targetUser.id, target.displayName);
      if (!result.ok) return interaction.reply({ content: `❌ Already allied with **${target.displayName}**!`, ephemeral: true });
      await sendToChannel('live', `⚔️ **ALLIANCE** — ${agent.displayName} 🤝 ${target.displayName}`);
      await sendToChannel('alliances', `⚔️ **${agent.displayName}** declared alliance with **${target.displayName}** at tick ${state.tick}`);
      return interaction.reply({ content: `⚔️ Alliance declared with **${target.displayName}**!` });
    }

    case 'rivals': {
      const rivalData = state.getRivals(user.id);
      if (!rivalData) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!rivalData.agent.alive) return interaction.reply({ content: '💀 Dead agents have no rivals.', ephemeral: true });
      const list = rivalData.rivals.map(r => `#${r.rank} **${r.name}** — ${r.energy}% ⚡ · ${r.bonds} bonds${r.isYou ? ' ◄ YOU' : ''}`).join('\n');
      return interaction.reply({ content: `**Your rank: #${rivalData.rank}/${rivalData.total}**\n\n${list}` });
    }
  }
}

async function handleTextCommand(message) {
  if (message.author.id === client.user.id) return;
  if (!message.content.startsWith('!')) return;
  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();

  switch (cmd) {
    case 'join': {
      const number = parseInt(args[1]);
      if (isNaN(number) || number < 0) return message.reply('Usage: `!join <number>`');
      const result = state.addAgent(message.author.id, message.author.displayName, number);
      if (!result.ok) return message.reply('Already joined! `!status`');
      const a = result.agent;
      await sendToChannel('live', `🆕 **${a.displayName}** joined! #${a.chosenNumber} → cell ${a.homeCell}`);
      return message.reply(`✅ #${a.chosenNumber} → home cell **${a.homeCell}** (${cellLabel(a.homeCell)})`);
    }
    case 'move': {
      const cell = parseInt(args[1]);
      if (isNaN(cell) || cell < 0 || cell > 26) return message.reply('Usage: `!move <0-26>`');
      const result = state.moveAgent(message.author.id, cell);
      if (!result.ok) return message.reply(`❌ ${result.reason}`);
      return message.reply(`📍 → **cell ${result.newCell}** (${cellLabel(result.newCell)})`);
    }
    case 'home': {
      const agent = state.getAgent(message.author.id);
      if (!agent) return message.reply('Not joined.');
      if (!agent.alive) return message.reply('💀');
      state.moveAgent(message.author.id, agent.homeCell);
      return message.reply(`🏠 → cell **${agent.homeCell}**`);
    }
    case 'status': {
      const agent = state.getAgent(message.author.id);
      if (!agent) return message.reply('Not joined.');
      return message.reply({ embeds: [statusEmbed(agent)] });
    }
    case 'grid': {
      const occupants = state.getGridState();
      return message.reply(`${renderCube(occupants, state.tick % 27)}\nTick: ${state.tick}`);
    }
    case 'leaderboard': case 'lb': return message.reply({ embeds: [leaderboardEmbed()] });
    case 'bonds': {
      const network = state.getBondNetwork(message.author.id);
      if (!network) return message.reply('Not joined.');
      if (network.connections.length === 0) return message.reply('No bonds yet.');
      return message.reply(`🔗 ${network.totalBonds} bonds (${network.crossLayerBonds}🌈)\n${network.connections.map(c => `**${c.name}** — ${c.bondCount}${c.crossLayer > 0 ? '🌈' : ''}`).join('\n')}`);
    }
    case 'who': {
      const cell = parseInt(args[1]);
      if (isNaN(cell) || cell < 0 || cell > 26) return message.reply('Usage: `!who <0-26>`');
      const agents = state.getAgentsInCell(cell);
      if (agents.length === 0) return message.reply(`Cell **${cell}** is empty.`);
      return message.reply(`Cell **${cell}**: ${agents.map(a => `**${a.displayName}** ${a.energy}%`).join(', ')}`);
    }
    case 'shout': {
      const agent = state.getAgent(message.author.id);
      if (!agent || !agent.alive) return message.reply('❌');
      const msg = args.slice(1).join(' ').slice(0, 200);
      if (!msg) return message.reply('Usage: `!shout <message>`');
      state.addShout(message.author.id, agent.displayName, msg);
      await sendToChannel('live', `📢 **${agent.displayName}** [cell ${agent.currentCell}]: ${msg}`);
      return message.reply('📢 Sent');
    }
    case 'rivals': {
      const rivalData = state.getRivals(message.author.id);
      if (!rivalData || !rivalData.agent.alive) return message.reply('❌');
      return message.reply(`Rank #${rivalData.rank}/${rivalData.total}\n${rivalData.rivals.map(r => `#${r.rank} **${r.name}** ${r.energy}%${r.isYou ? ' ◄' : ''}`).join('\n')}`);
    }
    case 'setup': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return message.reply('❌ Need Manage Channels permission.');
      const guild = message.guild;
      await message.reply('🔧 Setting up CLASHD-27...');
      const categories = {};
      for (const name of ['CLASHD-27 INFO','LEVER','THE FLOOR','NO HATS ALLOWED','MOD 27 ZONE','COMMUNITY']) {
        categories[name] = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildCategory) ||
          await guild.channels.create({ name, type: ChannelType.GuildCategory });
      }
      async function ensureChannel(name, parentName) {
        return guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText) ||
          await guild.channels.create({ name, type: ChannelType.GuildText, parent: categories[parentName] });
      }
      for (const ch of ['welcome','rules','info']) await ensureChannel(ch, 'CLASHD-27 INFO');
      for (const ch of ['clock','live','residue','leaderboard','graveyard']) await ensureChannel(ch, 'LEVER');
      for (let i = 0; i < 9; i++) await ensureChannel(`${CHANNEL_PREFIX}${i}`, 'THE FLOOR');
      for (let i = 9; i < 18; i++) await ensureChannel(`${CHANNEL_PREFIX}${i}`, 'NO HATS ALLOWED');
      for (let i = 18; i < 27; i++) await ensureChannel(`${CHANNEL_PREFIX}${i}`, 'MOD 27 ZONE');
      for (const ch of ['general','strategy','alliances']) await ensureChannel(ch, 'COMMUNITY');
      await cacheChannels(guild);
      return message.reply('✅ All channels created! CLASHD-27 is ready.');
    }
  }
}

async function handleCellPresence(message) {
  if (message.author.bot) return;
  const channelName = message.channel.name;
  if (!channelName.startsWith(CHANNEL_PREFIX)) return;
  const cellNum = parseInt(channelName.replace(CHANNEL_PREFIX, ''));
  if (isNaN(cellNum) || cellNum < 0 || cellNum > 26) return;
  const agent = state.getAgent(message.author.id);
  if (!agent || !agent.alive) return;
  if (agent.currentCell !== cellNum) state.moveAgent(message.author.id, cellNum);
}

client.once('ready', async () => {
  console.log(`[BOT] ${client.user.tag} online`);
  const guild = client.guilds.cache.first();
  if (guild) await cacheChannels(guild);
  console.log(`[CLOCK] Interval: ${TICK_INTERVAL / 1000}s`);
  clockTimer = setInterval(tick, TICK_INTERVAL);
  const activeCell = state.tick % 27;
  await sendToChannel('clock', `🌶 **CLASHD-27 is live.** Tick ${state.tick}. Active cell: **${activeCell}** (${cellLabel(activeCell)})`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try { await handleCommand(interaction); }
  catch (err) {
    console.error('[CMD]', err);
    const reply = { content: '❌ Error.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

client.on('messageCreate', async (message) => {
  await handleTextCommand(message);
  await handleCellPresence(message);
});

process.on('SIGINT', () => { clearInterval(clockTimer); state.save(); client.destroy(); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(clockTimer); state.save(); client.destroy(); process.exit(0); });

client.login(process.env.DISCORD_TOKEN);
