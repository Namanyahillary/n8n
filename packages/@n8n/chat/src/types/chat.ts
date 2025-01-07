import type { Ref } from 'vue';

import type { ChatMessage } from '@n8n/chat/types/messages';

export interface ConversationMeta {
	id: string;
	name: string;
	lastUpdated: string;
	messageCount: {
		user: number;
		bot: number;
	};
}

export interface Chat {
	agentId: Ref<string | null>;
	initialMessages: Ref<ChatMessage[]>;
	messages: Ref<ChatMessage[]>;
	currentSessionId: Ref<string | null>;
	waitingForResponse: Ref<boolean>;
	loadPreviousSession?: () => Promise<string | undefined>;
	startNewSession?: () => Promise<void>;
	sendMessage: (text: string, files: File[]) => Promise<void>;
	activeSessionId: Ref<string | null>;
	sessions: Ref<Map<string, ChatMessage[]>>;
	conversations: Ref<ConversationMeta[]>;
	switchSession: (sessionId: string) => Promise<string | undefined>;
	loadConversation: (conversationId: string) => Promise<void>;
	getCurrentSessionId: () => string | null;
}
