/**
 * CLASHD-27 — Register Discord Slash Commands
 * Run once: node register-commands.js
 */

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join CLASHD-27 with your chosen number')
    .addIntegerOption(opt => opt.setName('number').setDescription('Your number (mod 27 = your home cell)').setRequired(true).setMinValue(0)),

  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move to a cell in the cube')
    .addIntegerOption(opt => opt.setName('cell').setDescription('Target cell (0-26)').setRequired(true).setMinValue(0).setMaxValue(26)),

  new SlashCommandBuilder().setName('status').setDescription('Check your agent status'),
  new SlashCommandBuilder().setName('grid').setDescription('Show the current 3×3×3 cube state'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the CLASHD-27 leaderboard'),
  new SlashCommandBuilder().setName('bonds').setDescription('Show your bond network'),

  new SlashCommandBuilder()
    .setName('revive')
    .setDescription('Revive a dead agent (must be in their home cell)')
    .addUserOption(opt => opt.setName('agent').setDescription('The dead agent to revive').setRequired(true)),

  new SlashCommandBuilder().setName('home').setDescription('Return to your home cell'),
  new SlashCommandBuilder().setName('info').setDescription('Show CLASHD-27 rules and info'),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View an agent\'s public profile')
    .addUserOption(opt => opt.setName('agent').setDescription('The agent to look up (leave empty for yourself)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('who')
    .setDescription('See who\'s in a cell right now')
    .addIntegerOption(opt => opt.setName('cell').setDescription('Cell number (0-26)').setRequired(true).setMinValue(0).setMaxValue(26)),

  new SlashCommandBuilder()
    .setName('shout')
    .setDescription('Broadcast a message to #live')
    .addStringOption(opt => opt.setName('message').setDescription('Your message (max 200 chars)').setRequired(true).setMaxLength(200)),

  new SlashCommandBuilder()
    .setName('ally')
    .setDescription('Declare an alliance with another agent')
    .addUserOption(opt => opt.setName('agent').setDescription('The agent you want to ally with').setRequired(true)),

  new SlashCommandBuilder().setName('rivals').setDescription('See the agents closest to your rank'),
];

async function register() {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, process.env.DISCORD_GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

register();
