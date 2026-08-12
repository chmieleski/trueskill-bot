import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('register_lobby')
  .setDescription('Register a DBZ 5v5 match lobby (work in progress)');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  await interaction.editReply('Analyzing Ki...');
}
