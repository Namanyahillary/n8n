<script setup lang="ts">
import IconChevronDown from 'virtual:icons/mdi/chevron-down';
import OutlinePlus from 'virtual:icons/mdi/tooltip-outline-plus';
import { ref, computed } from 'vue';

import { useChat } from '@n8n/chat/composables';

const isOpen = ref(false);

const chatStore = useChat();
const { conversations, currentSessionId, startNewSession, loadConversation } = chatStore;

const currentConversationName = computed(() => {
	if (!conversations?.value || !currentSessionId?.value) {
		return 'New Chat';
	}

	const currentConv = conversations.value.find((c) => c.id === currentSessionId.value);
	return currentConv?.name ?? 'New Chat';
});

async function handleNewChat() {
	if (startNewSession) {
		isOpen.value = false;
		await startNewSession();
	}
}

async function handleLoadConversation(id: string) {
	if (loadConversation) {
		isOpen.value = false;
		await loadConversation(id);
	}
}
</script>

<template>
	<div class="conversation-switcher">
		<button class="conversation-current" type="button" @click="isOpen = !isOpen">
			<div class="conversation-current-text">
				<span class="material-icons conversation-icon">chat</span>
				{{ currentConversationName }}
			</div>
			<span class="material-icons chevron-icon" :class="{ 'rotate-180': isOpen }">
				<IconChevronDown height="32" width="32" />
			</span>
		</button>

		<div v-if="isOpen" class="conversation-dropdown">
			<button class="conversation-new" type="button" @click="handleNewChat">
				<OutlinePlus height="16" width="16" />
				<span>New Chat</span>
			</button>

			<div class="conversation-list">
				<button
					v-for="conv in conversations"
					:key="conv.id"
					class="conversation-item"
					:class="{ active: conv.id === currentSessionId }"
					type="button"
					@click="() => handleLoadConversation(conv.id)"
				>
					<span class="conversation-name">{{ conv.name }}</span>
					<span class="conversation-meta">
						{{ conv.messageCount.user + conv.messageCount.bot }} messages
					</span>
				</button>
			</div>
		</div>
	</div>
</template>

<style lang="scss">
.conversation-switcher {
	position: relative;
	width: 100%;
	border-style: none;

	.conversation-current {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 1rem;
		background: var(--chat--color-light);
		cursor: pointer;
		font-size: 0.875rem;
		transition: background-color 0.2s;
		border: none;
		border-bottom: 1px solid var(--chat--color-light-shade-100);

		&:hover {
			background: var(--chat--color-light-shade-50);
		}

		.conversation-current-text {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.chevron-icon {
			transition: transform 0.2s;

			&.rotate-180 {
				transform: rotate(180deg);
			}
		}
	}

	.conversation-dropdown {
		position: absolute;
		top: 2.5rem;
		left: 0;
		right: 0;
		margin-top: 0.5rem;
		background: var(--chat--color-white);
		border-radius: 0.5rem;
		z-index: 50;
		border: none;
	}

	.conversation-new {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		// border-bottom: 1px solid var(--chat--color-light-shade-100);
		cursor: pointer;
		font-size: 0.875rem;
		transition: background-color 0.2s;
		border: none;
		height: 2.8rem;

		&:hover {
			background: var(--chat--color-light-shade-50);
		}
	}

	.conversation-list {
		max-height: 16rem;
		overflow-y: auto;
		border: none;
	}

	.conversation-item {
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		padding: 0.5rem 1rem;
		cursor: pointer;
		text-align: left;
		transition: background-color 0.2s;
		border: 1px solid var(--chat--color-light-shade-100);

		&:hover {
			background: var(--chat--color-medium);
		}

		&.active {
			background: var(--chat--color-light-shade-100);
		}
	}

	.conversation-name {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--chat--color-dark);
	}

	.conversation-meta {
		font-size: 0.75rem;
		color: var(--chat--color-dark-shade-100);
	}
}
</style>
