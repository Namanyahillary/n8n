import { v4 as uuidv4 } from 'uuid';
import type { Plugin } from 'vue';
import { computed, nextTick, ref } from 'vue';

import * as api from '@n8n/chat/api';
import {
	ChatOptionsSymbol,
	ChatSymbol,
	localStorageSessionIdKey,
	localStorageSessionConversationKeys,
} from '@n8n/chat/constants';
import { chatEventBus } from '@n8n/chat/event-buses';
import type { ChatMessage, ChatOptions } from '@n8n/chat/types';
import type { ConversationMeta } from '@n8n/chat/types/chat';

function generateConversationName(): string {
	return new Date().toLocaleString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		hour12: true,
	});
}

function getStoredConversations(): ConversationMeta[] {
	try {
		const stored = localStorage.getItem(localStorageSessionConversationKeys);
		return stored ? JSON.parse(stored) : [];
	} catch (error) {
		return [];
	}
}

function updateStoredConversations(conversations: ConversationMeta[]): void {
	localStorage.setItem(localStorageSessionConversationKeys, JSON.stringify(conversations));
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const ChatPlugin: Plugin<ChatOptions> = {
	install(app, options) {
		app.provide(ChatOptionsSymbol, options);

		// Add new refs for managing multiple sessions
		const conversations = ref<ConversationMeta[]>([]);
		const sessions = ref<Map<string, ChatMessage[]>>(new Map());
		const currentSessionId = ref<string | null>(null);
		const activeSessionId = ref<string | null>(null);
		const agentId = ref<string | null>(null);

		const messages = computed(() =>
			activeSessionId.value ? (sessions.value.get(activeSessionId.value) ?? []) : [],
		);
		// Load stored conversations
		conversations.value = getStoredConversations();

		const waitingForResponse = ref(false);

		const initialMessages = computed<ChatMessage[]>(() =>
			(options.initialMessages ?? []).map((text) => ({
				id: uuidv4(),
				text,
				sender: 'bot',
				createdAt: new Date().toISOString(),
			})),
		);

		async function sendMessage(text: string, files: File[] = []) {
			if (!activeSessionId.value) return;

			const sentMessage: ChatMessage = {
				id: uuidv4(),
				text,
				sender: 'user',
				files,
				createdAt: new Date().toISOString(),
			};

			// Update the specific session's messages
			const sessionMessages = sessions.value.get(activeSessionId.value) ?? [];
			const updatedMessages = [...sessionMessages, sentMessage];
			sessions.value.set(activeSessionId.value, updatedMessages);

			waitingForResponse.value = true;

			void nextTick(() => {
				chatEventBus.emit('scrollToBottom');
			});

			const sendMessageResponse = await api.sendMessage(
				text,
				files,
				activeSessionId.value,
				options,
			);

			let textMessage = sendMessageResponse.output ?? sendMessageResponse.text ?? '';

			if (textMessage === '' && Object.keys(sendMessageResponse).length > 0) {
				try {
					textMessage = JSON.stringify(sendMessageResponse, null, 2);
				} catch (e) {
					// Failed to stringify the object so fallback to empty string
				}
			}

			const receivedMessage: ChatMessage = {
				id: uuidv4(),
				text: textMessage,
				sender: 'bot',
				createdAt: new Date().toISOString(),
			};

			// Update messages with bot response
			const finalMessages = [...updatedMessages, receivedMessage];
			sessions.value.set(activeSessionId.value, finalMessages);

			// Check if this session should be added to conversations
			const messageStats = {
				user: finalMessages.filter((m) => m.sender === 'user').length,
				bot: finalMessages.filter((m) => m.sender === 'bot').length,
			};

			if (messageStats.user > 0 && messageStats.bot > 0) {
				const existingConversation = conversations.value.find(
					(c) => c.id === activeSessionId.value,
				);

				if (existingConversation) {
					// Update existing conversation
					existingConversation.lastUpdated = new Date().toISOString();
					existingConversation.messageCount = messageStats;
				} else {
					// Add new conversation
					conversations.value.push({
						id: activeSessionId.value,
						name: generateConversationName(),
						lastUpdated: new Date().toISOString(),
						messageCount: messageStats,
					});
				}

				// Sort conversations by last updated
				conversations.value.sort(
					(a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
				);

				// Store updated conversations
				updateStoredConversations(conversations.value);
			}

			waitingForResponse.value = false;

			void nextTick(() => {
				chatEventBus.emit('scrollToBottom');
			});
		}

		// Add function to load a conversation
		async function loadConversation(conversationId: string) {
			await switchSession(conversationId);
			const conversation = conversations.value.find((c) => c.id === conversationId);
			if (conversation) {
				// Update last accessed time
				conversation.lastUpdated = new Date().toISOString();
				updateStoredConversations(conversations.value);
			}
		}

		// Add new function to switch between sessions
		async function switchSession(sessionId: string): Promise<string | undefined> {
			activeSessionId.value = sessionId;
			currentSessionId.value = sessionId;
			if (!sessions.value.has(sessionId)) {
				sessions.value.set(sessionId, []);

				waitingForResponse.value = true;
				const previousMessagesResponse = await api.loadPreviousSession(
					`${options.agentId ? options.agentId + '-' : ''}${sessionId}`,
					options,
				);
				waitingForResponse.value = false;

				const timestamp = new Date().toISOString();

				const sessionMessages = (previousMessagesResponse?.data || []).map((message, index) => ({
					id: `${index}`,
					text: message.kwargs.content,
					sender: message.id.includes('HumanMessage') ? 'user' : ('bot' as 'bot' | 'user'), // Fix the type here
					createdAt: timestamp,
				}));

				sessions.value.set(sessionId, sessionMessages);
				return sessionId;
			}

			return undefined;
		}

		async function loadPreviousSession(): Promise<string | undefined> {
			if (!options.loadPreviousSession) {
				return;
			}

			const sessionId = localStorage.getItem(localStorageSessionIdKey);

			if (sessionId) {
				// Check if this session exists in our conversations
				const storedConversations = getStoredConversations();
				const existingConversation = storedConversations.find((conv) => conv.id === sessionId);

				if (existingConversation) {
					// Load stored conversations into state
					conversations.value = storedConversations;

					// Load the specific session
					return await switchSession(sessionId);
				}
			}

			// If no valid previous session, start a new one
			await startNewSession();
			return undefined;
		}

		// if you need to get the current session ID
		function getCurrentSessionId(): string | null {
			return currentSessionId.value;
		}

		// Also update startNewSession to handle conversations properly
		async function startNewSession(): Promise<void> {
			const newSessionId = uuidv4();
			activeSessionId.value = newSessionId;
			currentSessionId.value = newSessionId;

			// Initialize empty message list for new session
			sessions.value.set(newSessionId, initialMessages.value);

			// Update localStorage
			localStorage.setItem(localStorageSessionIdKey, newSessionId);
		}

		const chatStore = {
			agentId,
			initialMessages,
			messages,
			currentSessionId,
			activeSessionId,
			sessions,
			conversations,
			waitingForResponse,
			loadPreviousSession,
			startNewSession,
			sendMessage,
			switchSession,
			loadConversation,
			getCurrentSessionId, // Optional: Add if you need to access the session ID
		};

		app.provide(ChatSymbol, chatStore);
		app.config.globalProperties.$chat = chatStore;
	},
};
