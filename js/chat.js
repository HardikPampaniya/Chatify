const state = {
    currentUser: null,
    selectedUser: null,
    conversation: null,
    conversations: [],
    users: [],
    friendRequests: { incoming: [], outgoing: [] },
    onlineUsers: new Set(),
    pendingMessageIds: new Map(),
    socket: null,
    renderedMessageIds: new Set(),
    syncingLiveState: false,
    selectionToken: 0,
    searchToken: 0,
    searchTimer: null,
    typingTimer: null,
    remoteTypingTimer: null,
    remoteTyping: false,
    call: null,
    callDurationTimer: null,
    reconnectTimer: null,
    closeCallTimer: null,
    uploadRequest: null,
    uploadActive: false,
    cancelUploadRequested: false,
    multipartUploadId: null,
    pendingUploadIds: new Map(),
    uploadPreviewUrl: null,
    uploadHideTimer: null,
    callTrigger: null
};

const byId = id => document.getElementById(id);
const userList = byId("userList");
const messages = byId("messages");
const messageInput = byId("messageInput");
const sendBtn = document.querySelector(".send-btn");
const attachBtn = byId("attachBtn");
const mediaInput = byId("mediaInput");
const callOverlay = byId("callOverlay");
const incomingActions = byId("incomingActions");
const activeActions = byId("activeActions");
const remoteVideo = byId("remoteVideo");
const localVideo = byId("localVideo");
const remoteAudio = byId("remoteAudio");

const getId = value => String(value && typeof value === "object" ? value._id || value.id || "" : value || "");
const conversationId = () => state.conversation ? getId(state.conversation._id) : "";
const pendingKey = (id, text) => `${id}\u0000${text}`;
const MAX_MEDIA_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 4 * 1024 * 1024;

const api = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    const token = sessionStorage.getItem("chatify.session");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { credentials: "include", ...options, headers });
    if (response.status === 401) {
        sessionStorage.removeItem("chatify.session");
        window.location.href = "/";
        throw new Error("Your session has ended. Sign in again.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Request failed. Please try again.");
    return data;
};

const setChatStatus = message => {
    const status = byId("chatStatus");
    if (status) status.textContent = message;
};

const formatTime = value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formatBytes = bytes => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
};

const updateChatStatus = () => {
    if (!state.selectedUser) return;
    if (!state.socket?.connected) {
        setChatStatus("Reconnecting to chat…");
        return;
    }
    if (state.remoteTyping) {
        setChatStatus(`${state.selectedUser.username} is typing…`);
        return;
    }
    const online = state.onlineUsers.has(getId(state.selectedUser._id));
    if (online) {
        setChatStatus("Online · Private conversation");
    } else {
        const lastSeen = state.selectedUser.lastSeen ? new Date(state.selectedUser.lastSeen) : null;
        const ago = lastSeen && !Number.isNaN(lastSeen.getTime())
            ? `Last seen ${lastSeen.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
            : "Offline";
        setChatStatus(`${ago} · Private conversation`);
    }
};

const updateConversationControls = () => {
    const enabled = Boolean(state.conversation);
    messageInput.disabled = !enabled;
    sendBtn.disabled = !enabled || !state.socket?.connected;
    attachBtn.disabled = !enabled;
    byId("voiceCallBtn").disabled = !enabled || !state.socket?.connected || Boolean(state.call);
    byId("videoCallBtn").disabled = !enabled || !state.socket?.connected || Boolean(state.call);
};

const clearMessages = (title, detail) => {
    state.renderedMessageIds.clear();
    const panel = document.createElement("div");
    panel.className = "empty-state";
    panel.id = "emptyMessages";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const text = document.createElement("p");
    text.textContent = detail;
    panel.append(heading, text);
    messages.replaceChildren(panel);
};

const mediaUrl = message => `/api/messages/media/${encodeURIComponent(getId(message._id))}`;
const authorizedMediaUrl = async message => {
    const data = await api(`${mediaUrl(message)}/access`);
    return data.url;
};
const findMessageRow = messageId => [...messages.querySelectorAll(".message-row")]
    .find(row => row.dataset.messageId === String(messageId));

const removeMessageForMe = ({ messageId, conversationId: deletedConversationId }) => {
    const row = findMessageRow(messageId);
    if (row) {
        state.renderedMessageIds.delete(row.dataset.messageId);
        row.remove();
        if (!messages.querySelector(".message-row")) clearMessages("No messages yet", "Send a message, share a file or start a call.");
    }
    const conversation = state.conversations.find(item => getId(item._id) === String(deletedConversationId));
    if (conversation && getId(conversation.lastMessage?._id) === String(messageId)) {
        conversation.lastMessage = null;
        renderConversations();
    }
};

const markMessageDeletedForEveryone = event => {
    const row = findMessageRow(event.messageId);
    if (row) {
        const bubble = row.querySelector(".bubble");
        const footer = bubble.querySelector(".message-footer");
        bubble.replaceChildren();
        bubble.classList.add("deleted-bubble");
        const text = document.createElement("span");
        text.textContent = "This message was deleted";
        footer?.querySelector(".message-menu")?.remove();
        bubble.append(text);
        if (footer) bubble.append(footer);
    }

    const conversation = state.conversations.find(item => getId(item._id) === String(event.conversationId));
    if (conversation && getId(conversation.lastMessage?._id) === String(event.messageId)) {
        conversation.lastMessage = { _id: event.messageId, type: "deleted", text: "This message was deleted" };
        renderConversations();
    }
};

const makeAttachment = message => {
    const link = document.createElement("a");
    link.className = "attachment";
    link.href = "#";
    link.setAttribute("aria-label", `Download ${message.media?.originalName || "attachment"}`);
    link.addEventListener("click", async event => {
        event.preventDefault();
        link.setAttribute("aria-busy", "true");
        try {
            const url = await authorizedMediaUrl(message);
            const download = document.createElement("a");
            download.href = url;
            download.download = message.media?.originalName || "attachment";
            download.hidden = true;
            document.body.appendChild(download);
            download.click();
            download.remove();
        } catch (error) {
            setChatStatus(error.message || "Could not prepare this download.");
        } finally {
            link.removeAttribute("aria-busy");
        }
    });

    const icon = document.createElement("span");
    icon.className = "attachment-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "↓";
    const copy = document.createElement("span");
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = message.media?.originalName || "Download file";
    const hint = document.createElement("span");
    hint.className = "attachment-hint";
    hint.textContent = formatBytes(message.media?.size);
    copy.append(name, hint);
    link.append(icon, copy);
    return link;
};

const renderMessage = message => {
    const id = getId(message._id || message.id);
    if (message.clientMessageId) {
        const optimisticRow = [...messages.querySelectorAll(".message-row")]
            .find(row => row.dataset.clientMessageId === message.clientMessageId && row.dataset.messageId !== id);
        if (optimisticRow) {
            state.renderedMessageIds.delete(optimisticRow.dataset.messageId);
            optimisticRow.remove();
        }
    }
    if (!id || state.renderedMessageIds.has(id)) return;
    state.renderedMessageIds.add(id);

    const empty = byId("emptyMessages");
    if (empty) empty.remove();

    const senderId = getId(message.sender);
    const row = document.createElement("article");
    const mine = senderId === getId(state.currentUser?.id);
    row.className = `message-row ${mine ? "mine" : "theirs"}`;
    row.dataset.messageId = id;
    row.dataset.senderId = senderId;
    row.dataset.createdAt = message.createdAt || new Date().toISOString();
    if (message.clientMessageId) row.dataset.clientMessageId = message.clientMessageId;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (message.deletedForEveryone || message.type === "deleted") {
        bubble.classList.add("deleted-bubble");
        bubble.textContent = "This message was deleted";
    } else if (message.type === "image" || message.type === "video" || message.type === "audio") {
        const media = document.createElement(message.type === "image" ? "img" : message.type);
        media.className = "media";
        media.preload = "metadata";
        media.loading = "lazy";
        media.setAttribute("aria-label", message.media?.originalName || `${message.type} attachment`);
        if (message.type === "image") media.alt = message.media?.originalName || "Shared image";
        if (message.type === "video") media.controls = true;
        if (message.type === "audio") media.controls = true;
        let refreshedAccess = false;
        const loadMedia = () => authorizedMediaUrl(message).then(url => {
            if (media.isConnected) media.src = url;
        }).catch(() => {
            if (media.isConnected) media.setAttribute("aria-label", "Could not load this attachment");
        });
        media.addEventListener("error", () => {
            if (refreshedAccess || !media.isConnected) return;
            refreshedAccess = true;
            loadMedia();
        }, { once: true });
        loadMedia();
        bubble.appendChild(media);
    } else if (message.type === "document") {
        bubble.appendChild(makeAttachment(message));
    } else {
        bubble.textContent = String(message.text || "");
    }

    if (message.pending) row.classList.add("message-pending");
    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = message.pending ? "Sending…" : formatTime(message.createdAt);
    const date = new Date(message.createdAt);
    if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();

    const footer = document.createElement("div");
    footer.className = "message-footer";
    footer.appendChild(time);
    if (!message.pending && !message.deletedForEveryone && message.type !== "deleted") {
        const menu = document.createElement("details");
        menu.className = "message-menu";
        const trigger = document.createElement("summary");
        trigger.textContent = "⋯";
        trigger.setAttribute("aria-label", "Message actions");
        trigger.title = "Message actions";
        const panel = document.createElement("div");
        panel.className = "message-menu-panel";
        const deleteForMe = document.createElement("button");
        deleteForMe.type = "button";
        deleteForMe.textContent = "Delete for me";
        deleteForMe.addEventListener("click", () => deleteChatMessage(message, "me", menu));
        panel.appendChild(deleteForMe);
        if (mine) {
            const deleteForEveryone = document.createElement("button");
            deleteForEveryone.type = "button";
            deleteForEveryone.className = "danger-action";
            deleteForEveryone.textContent = "Delete for everyone";
            deleteForEveryone.addEventListener("click", () => deleteChatMessage(message, "everyone", menu));
            panel.appendChild(deleteForEveryone);
        }
        menu.append(trigger, panel);
        footer.appendChild(menu);
    }
    bubble.appendChild(footer);
    row.appendChild(bubble);
    messages.appendChild(row);

    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 180;
    if (nearBottom || mine) messages.scrollTop = messages.scrollHeight;
};

const renderMessages = list => {
    clearMessages("No messages yet", "Send a message, share a file or start a call.");
    list.forEach(message => {
        const clientId = message.clientMessageId;
        const key = pendingKey(getId(message.conversation), message.text || "");
        if (clientId && state.pendingMessageIds.get(key) === clientId) {
            state.pendingMessageIds.delete(key);
            if (messageInput.value === message.text) messageInput.value = "";
        }
    });
    if (!list.length) return;
    messages.replaceChildren();
    list.forEach(renderMessage);
    messages.scrollTop = messages.scrollHeight;
};

const loadMessages = async expectedConversationId => {
    const data = await api(`/api/messages/${encodeURIComponent(expectedConversationId)}`);
    if (conversationId() !== expectedConversationId) return;
    renderMessages(data.messages || []);
};

const makePersonRow = (user, subtitle, actions = [], variant = "") => {
    const row = document.createElement("div");
    row.className = `user-item person-row ${variant}`.trim();

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = (user.username || "?").charAt(0).toUpperCase();
    const online = state.onlineUsers.has(getId(user._id));
    const dot = document.createElement("span");
    dot.className = `presence-dot ${online ? "online" : ""}`;
    dot.setAttribute("aria-hidden", "true");
    avatar.appendChild(dot);

    const copy = document.createElement("span");
    copy.className = "user-copy";
    const name = document.createElement("span");
    name.className = "user-name";
    name.textContent = user.username || "Chat user";
    const detail = document.createElement("span");
    detail.className = "user-email";
    detail.textContent = subtitle;
    copy.append(name, detail);

    const actionsWrap = document.createElement("span");
    actionsWrap.className = "user-actions";
    actions.forEach(action => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `request-action ${action.kind || ""}`;
        button.textContent = action.label;
        button.disabled = Boolean(action.disabled);
        button.addEventListener("click", event => {
            event.stopPropagation();
            action.onClick(button);
        });
        actionsWrap.appendChild(button);
    });

    row.append(avatar, copy);
    if (actions.length) row.appendChild(actionsWrap);
    return row;
};

const renderUsers = () => {
    const search = byId("userSearch").value.trim();
    userList.replaceChildren();
    if (search.length < 2) {
        byId("contactStatus").textContent = "Search by username (at least 2 characters).";
        return;
    }
    if (!state.users.length) {
        byId("contactStatus").textContent = "No usernames match that search.";
        return;
    }

    byId("contactStatus").textContent = `${state.users.length} ${state.users.length === 1 ? "match" : "matches"}`;
    state.users.forEach(user => {
        const relationship = user.relationship?.status || "none";
        const subtitle = state.onlineUsers.has(getId(user._id)) ? "Online" : (relationship === "friend" ? "Connected" : "Send a request before chatting");
        let actions;
        if (relationship === "friend") {
            actions = [{ label: "Message", kind: "primary", onClick: () => selectUser(user) }];
        } else if (relationship === "outgoing") {
            actions = [{ label: "Request sent", kind: "quiet", disabled: true }];
        } else if (relationship === "incoming") {
            actions = [{ label: "Accept", kind: "primary", onClick: button => acceptFriendRequest(user.relationship.requestId, button) }];
        } else {
            actions = [{ label: "Add friend", kind: "primary", onClick: button => sendFriendRequest(user, button) }];
        }
        userList.appendChild(makePersonRow(user, subtitle, actions, "search-result-row"));
    });
};

const renderFriendRequests = () => {
    const list = byId("friendRequestList");
    const incoming = state.friendRequests.incoming || [];
    const outgoing = state.friendRequests.outgoing || [];
    list.replaceChildren();
    const total = incoming.length + outgoing.length;
    byId("requestsStatus").textContent = total
        ? `${incoming.length} incoming · ${outgoing.length} sent`
        : "No pending requests.";

    incoming.forEach(request => {
        list.appendChild(makePersonRow(request.user, "Wants to connect with you", [
            { label: "Accept", kind: "primary", onClick: button => acceptFriendRequest(request._id, button) },
            { label: "Decline", kind: "quiet", onClick: button => rejectFriendRequest(request._id, button) }
        ], "request-row incoming-request"));
    });
    outgoing.forEach(request => {
        list.appendChild(makePersonRow(request.user, "Waiting for their response", [
            { label: "Cancel request", kind: "quiet", onClick: button => cancelFriendRequest(request._id, button) }
        ], "request-row outgoing-request"));
    });
};

const loadFriendRequests = async () => {
    const data = await api("/api/users/requests");
    state.friendRequests = { incoming: data.incoming || [], outgoing: data.outgoing || [] };
    renderFriendRequests();
};

const searchUsers = async (search = byId("userSearch").value.trim()) => {
    const query = search.trim();
    const token = ++state.searchToken;
    if (query.length < 2) {
        state.users = [];
        renderUsers();
        return;
    }

    byId("contactStatus").textContent = "Searching…";
    try {
        const data = await api(`/api/users?q=${encodeURIComponent(query)}`);
        if (token !== state.searchToken) return;
        state.users = data.users || [];
        renderUsers();
    } catch (error) {
        if (token === state.searchToken) byId("contactStatus").textContent = error.message || "Search failed. Try again.";
    }
};

const refreshPeople = async () => {
    await Promise.all([loadFriendRequests(), searchUsers()]);
};

const sendFriendRequest = async (user, button) => {
    button.disabled = true;
    button.textContent = "Sending…";
    try {
        await api(`/api/users/requests/${encodeURIComponent(getId(user._id))}`, { method: "POST" });
        await refreshPeople();
    } catch (error) {
        button.disabled = false;
        button.textContent = "Add friend";
        byId("contactStatus").textContent = error.message || "Could not send request.";
    }
};

const acceptFriendRequest = async (requestId, button) => {
    if (button) { button.disabled = true; button.textContent = "Accepting…"; }
    try {
        await api(`/api/users/requests/${encodeURIComponent(getId(requestId))}/accept`, { method: "POST" });
        await Promise.all([refreshPeople(), loadConversations()]);
    } catch (error) {
        if (button) { button.disabled = false; button.textContent = "Accept"; }
        byId("requestsStatus").textContent = error.message || "Could not accept request.";
    }
};

const rejectFriendRequest = async (requestId, button) => {
    button.disabled = true;
    try {
        await api(`/api/users/requests/${encodeURIComponent(getId(requestId))}/reject`, { method: "POST" });
        await refreshPeople();
    } catch (error) {
        button.disabled = false;
        byId("requestsStatus").textContent = error.message || "Could not decline request.";
    }
};

const cancelFriendRequest = async (requestId, button) => {
    button.disabled = true;
    try {
        await api(`/api/users/requests/${encodeURIComponent(getId(requestId))}`, { method: "DELETE" });
        await refreshPeople();
    } catch (error) {
        button.disabled = false;
        byId("requestsStatus").textContent = error.message || "Could not cancel request.";
    }
};

const renderConversations = () => {
    const search = byId("userSearch").value.toLowerCase().trim();
    const list = state.conversations
        .map(conversation => ({
            conversation,
            person: (conversation.participants || []).find(user => getId(user) !== getId(state.currentUser?.id))
        }))
        .filter(item => item.person && `${item.person.username} ${item.person.email}`.toLowerCase().includes(search));
    const nav = byId("conversationList");
    nav.replaceChildren();
    byId("conversationEmpty").hidden = list.length > 0;
    byId("conversationEmpty").textContent = state.conversations.length
        ? "No conversations match your search."
        : "No conversations yet.";

    list.forEach(({ conversation, person }) => {
        const id = getId(person._id);
        const online = state.onlineUsers.has(id);
        const button = document.createElement("button");
        button.type = "button";
        button.className = `user-item ${getId(state.selectedUser?._id) === id ? "active" : ""}`;
        button.setAttribute("aria-current", getId(state.selectedUser?._id) === id ? "true" : "false");
        button.setAttribute("aria-label", `Open conversation with ${person.username}${online ? ", online" : ""}`);

        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.textContent = (person.username || "?").charAt(0).toUpperCase();
        const dot = document.createElement("span");
        dot.className = `presence-dot ${online ? "online" : ""}`;
        dot.setAttribute("aria-hidden", "true");
        avatar.appendChild(dot);

        const copy = document.createElement("span");
        copy.className = "user-copy";
        const name = document.createElement("span");
        name.className = "user-name";
        name.textContent = person.username;
        const preview = document.createElement("span");
        preview.className = "user-email";
        const lastMessage = conversation.lastMessage;
        preview.textContent = !lastMessage ? "Start a conversation" : lastMessage.type === "deleted" ? "This message was deleted" : lastMessage.type === "text" ? lastMessage.text || "Message" : ({ image: "Photo", video: "Video", audio: "Audio", document: "File" }[lastMessage.type] || "Attachment");
        copy.append(name, preview);
        button.append(avatar, copy);
        button.addEventListener("click", () => selectUser(person));
        nav.appendChild(button);
    });
};

const loadConversations = async () => {
    const data = await api("/api/conversations");
    const previous = state.conversations;
    const fresh = data.conversations || [];
    const freshIds = new Set(fresh.map(item => getId(item._id)));
    state.conversations = [...fresh, ...previous.filter(item => !freshIds.has(getId(item._id)))];
    renderConversations();
};

const updateRecentConversation = message => {
    const id = getId(message.conversation);
    const index = state.conversations.findIndex(item => getId(item._id) === id);
    if (index < 0) return;
    state.conversations[index].lastMessage = message;
    state.conversations[index].updatedAt = message.createdAt;
    state.conversations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    renderConversations();
};

const deleteChatMessage = async (message, scope, menu) => {
    const prompt = scope === "everyone"
        ? "Delete this message and its media for everyone?"
        : "Remove this message from your chat?";
    if (!window.confirm(prompt)) return;

    if (menu) menu.open = false;
    try {
        const conversation = getId(message.conversation) || conversationId();
        const result = await api(`/api/messages/${encodeURIComponent(conversation)}/${encodeURIComponent(getId(message._id))}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scope })
        });
        if (scope === "me") removeMessageForMe(result);
        else markMessageDeletedForEveryone(result);
    } catch (error) {
        setChatStatus(error.message || "Could not delete this message.");
    }
};

const selectUser = async user => {
    const token = ++state.selectionToken;
    const oldId = conversationId();
    if (oldId) state.socket?.emit("leave_conversation", oldId);

    state.selectedUser = user;
    state.conversation = null;
    state.remoteTyping = false;
    clearTimeout(state.remoteTypingTimer);
    renderUsers();
    byId("chatShell").classList.add("is-chat-open");
    byId("chatTitle").textContent = user.username;
    setChatStatus("Opening private conversation…");
    updateConversationControls();
    clearMessages("Loading conversation…", "Your messages will appear here.");

    try {
        const data = await api(`/api/conversations/${encodeURIComponent(getId(user._id))}`, { method: "POST" });
        if (token !== state.selectionToken) return;
        state.conversation = data.conversation;
        const id = conversationId();
        const existingIndex = state.conversations.findIndex(item =>
            (item.participants || []).some(participant => getId(participant) === getId(user._id))
        );
        const existingConversation = existingIndex < 0 ? null : state.conversations[existingIndex];
        state.conversations = [
            { ...(existingConversation || {}), ...data.conversation, lastMessage: existingConversation?.lastMessage || data.conversation.lastMessage || null },
            ...state.conversations.filter((_, index) => index !== existingIndex)
        ];
        renderConversations();
        updateConversationControls();
        if (state.socket?.connected) {
            state.socket.emit("join_conversation", id, response => {
                if (response?.error && token === state.selectionToken) setChatStatus(response.error);
            });
        }
        await loadMessages(id);
        if (token === state.selectionToken) {
            updateChatStatus();
            messageInput.focus({ preventScroll: true });
        }
    } catch (error) {
        if (token === state.selectionToken) {
            setChatStatus(error.message);
            clearMessages("Could not open this chat", "Check your connection and try again.");
        }
    }
};

const sendTyping = typing => {
    if (!state.socket?.connected || !state.conversation) return;
    state.socket.emit("typing", { conversationId: conversationId(), typing });
};

const initSocket = () => {
    state.socket = io({
        withCredentials: true,
        auth: { token: sessionStorage.getItem("chatify.session") || "" },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelayMax: 5000
    });

    state.socket.on("connect", async () => {
        updateConversationControls();
        if (state.conversation) {
            const id = conversationId();
            state.socket.emit("join_conversation", id);
            loadMessages(id).catch(() => setChatStatus("Could not refresh messages. Check your connection."));
        } else {
            updateChatStatus();
        }
        loadConversations().catch(() => {});
    });

    state.socket.on("disconnect", () => {
        updateConversationControls();
        if (state.selectedUser) setChatStatus("Reconnecting to chat…");
    });

    state.socket.on("connect_error", () => {
        if (state.selectedUser) setChatStatus("Chat connection unavailable. Reconnecting…");
    });

    state.socket.on("presence:snapshot", ids => {
        state.onlineUsers = new Set((ids || []).map(getId));
        renderUsers();
        renderConversations();
        updateChatStatus();
    });

    state.socket.on("presence:changed", data => {
        const id = getId(data?.userId);
        if (!id || id === getId(state.currentUser?.id)) return;
        if (data.online) state.onlineUsers.add(id);
        else state.onlineUsers.delete(id);
        renderUsers();
        renderConversations();
        updateChatStatus();
    });

    state.socket.on("new_message", message => {
        updateRecentConversation(message);
        if (conversationId() && getId(message.conversation) === conversationId()) renderMessage(message);
    });

    state.socket.on("message:deleted_for_me", removeMessageForMe);
    state.socket.on("message:deleted_for_everyone", markMessageDeletedForEveryone);

    state.socket.on("friend_requests:updated", () => {
        refreshLiveState();
    });

    state.socket.on("chat_error", message => {
        if (state.selectedUser) setChatStatus(String(message || "Chat error"));
    });

    state.socket.on("typing", data => {
        if (getId(data.userId) === getId(state.currentUser?.id) || getId(data.conversationId) !== conversationId()) return;
        state.remoteTyping = Boolean(data.typing);
        clearTimeout(state.remoteTypingTimer);
        if (state.remoteTyping) {
            state.remoteTypingTimer = setTimeout(() => {
                state.remoteTyping = false;
                updateChatStatus();
            }, 2400);
        }
        updateChatStatus();
    });

    state.socket.on("call:incoming", data => {
        if (state.call) {
            state.socket.emit("call:reject", { callId: data.callId });
            return;
        }
        state.call = {
            callId: data.callId,
            conversationId: data.conversationId,
            peerId: data.callerId,
            peerName: data.callerName || "Chat user",
            mode: data.mode,
            role: "callee",
            status: "incoming",
            iceServers: null,
            localStream: null,
            peerConnection: null,
            pendingCandidates: [],
            restartAttempts: 0
        };
        state.callTrigger = document.activeElement;
        showCall("Incoming call", `${state.call.peerName} is calling by ${state.call.mode === "video" ? "video" : "voice"}.`, true);
        byId("callAcceptBtn").focus({ preventScroll: true });
    });

    state.socket.on("call:accepted", async data => {
        const call = state.call;
        if (!call || call.callId !== data.callId || call.role !== "caller") return;
        call.status = "connecting";
        showCall("Connecting…", "Setting up a secure peer connection.", false);
        try {
            await createAndSendOffer();
        } catch (error) {
            byId("callError").textContent = error.message || "Could not create the call connection.";
            endCall("ended", true);
        }
    });

    state.socket.on("call:offer", async data => {
        const call = state.call;
        if (!call || call.callId !== data.callId || call.role !== "callee" || !call.peerConnection) return;
        try {
            await call.peerConnection.setRemoteDescription(data.description);
            await applyPendingCandidates(call);
            const answer = await call.peerConnection.createAnswer();
            await call.peerConnection.setLocalDescription(answer);
            state.socket.emit("call:answer", { callId: call.callId, description: call.peerConnection.localDescription }, response => {
                if (response?.error) byId("callError").textContent = response.error;
            });
        } catch {
            byId("callError").textContent = "Could not connect this call. Check your network and try again.";
        }
    });

    state.socket.on("call:answer", async data => {
        const call = state.call;
        if (!call || call.callId !== data.callId || call.role !== "caller" || !call.peerConnection) return;
        try {
            await call.peerConnection.setRemoteDescription(data.description);
            await applyPendingCandidates(call);
        } catch {
            byId("callError").textContent = "Could not finish connecting. Try ending the call and calling again.";
        }
    });

    state.socket.on("call:candidate", async data => {
        const call = state.call;
        if (!call || call.callId !== data.callId || !data.candidate || !call.peerConnection) return;
        if (!call.peerConnection.remoteDescription) call.pendingCandidates.push(data.candidate);
        else {
            try { await call.peerConnection.addIceCandidate(data.candidate); } catch { /* Candidate may arrive after a restart. */ }
        }
    });

    state.socket.on("call:ended", data => {
        if (!state.call || state.call.callId !== data.callId) return;
        const text = data.reason === "rejected" ? "Call declined" :
            data.reason === "unanswered" ? "No answer" :
            data.reason === "peer_disconnected" ? "The other person disconnected" : "Call ended";
        finishCallUi(text);
    });

    state.socket.on("call:error", data => {
        if (state.call) byId("callError").textContent = data?.message || "Call signaling failed.";
    });
};

const refreshLiveState = async () => {
    if (state.syncingLiveState || document.visibilityState === "hidden") return;
    state.syncingLiveState = true;
    try {
        await Promise.all([
            loadFriendRequests(),
            loadConversations(),
            byId("userSearch").value.trim().length >= 2 ? searchUsers() : Promise.resolve()
        ]);
    } catch {
        // Keep the current view; the next timer or socket event will retry.
    } finally {
        state.syncingLiveState = false;
    }
};

const sendMessage = () => {
    const text = messageInput.value.trim();
    if (!conversationId() || !text || !state.socket?.connected || sendBtn.disabled) return;
    const activeConversationId = conversationId();
    const key = pendingKey(activeConversationId, text);
    const payload = {
        conversationId: activeConversationId,
        text,
        clientMessageId: state.pendingMessageIds.get(key) || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)
    };
    state.pendingMessageIds.delete(key);
    renderMessage({
        _id: `pending:${payload.clientMessageId}`,
        conversation: activeConversationId,
        sender: state.currentUser.id,
        receiver: getId(state.selectedUser?._id),
        clientMessageId: payload.clientMessageId,
        text,
        type: "text",
        createdAt: new Date().toISOString(),
        pending: true
    });
    messageInput.value = "";
    sendTyping(false);
    state.socket.timeout(10_000).emit("send_message", payload, (timeoutError, response) => {
        if (timeoutError || response?.error) {
            state.pendingMessageIds.set(key, payload.clientMessageId);
            const optimisticRow = findMessageRow(`pending:${payload.clientMessageId}`);
            if (optimisticRow) {
                state.renderedMessageIds.delete(optimisticRow.dataset.messageId);
                optimisticRow.remove();
            }
            if (!messageInput.value) messageInput.value = text;
            setChatStatus(timeoutError ? "Message not confirmed. Check your connection and try again." : response.error);
            return;
        }
        state.pendingMessageIds.delete(key);
        if (response?.message) {
            updateRecentConversation(response.message);
            if (conversationId() === activeConversationId) renderMessage(response.message);
        }
        updateChatStatus();
    });
};

document.querySelector("#messageForm").addEventListener("submit", event => {
    event.preventDefault();
    sendMessage();
});

messageInput.addEventListener("input", () => {
    if (!state.conversation) return;
    sendTyping(true);
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => sendTyping(false), 950);
});
messageInput.addEventListener("blur", () => {
    clearTimeout(state.typingTimer);
    sendTyping(false);
});

byId("userSearch").addEventListener("input", () => {
    renderConversations();
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => searchUsers(), 250);
});
byId("backToList").addEventListener("click", () => {
    const id = conversationId();
    if (id) state.socket?.emit("leave_conversation", id);
    state.selectionToken += 1;
    state.selectedUser = null;
    state.conversation = null;
    state.remoteTyping = false;
    byId("chatShell").classList.remove("is-chat-open");
    byId("chatTitle").textContent = "Select a person";
    setChatStatus("Choose someone to start a private chat.");
    clearMessages("Your private messages", "Select a person to begin a conversation.");
    updateConversationControls();
    renderUsers();
});

byId("logoutBtn").addEventListener("click", async () => {
    try {
        await api("/api/auth/logout", { method: "POST" });
        sessionStorage.removeItem("chatify.session");
        window.location.href = "/";
    } catch (error) {
        setChatStatus(error.message);
    }
});

const clearUploadPreview = () => {
    if (state.uploadPreviewUrl) URL.revokeObjectURL(state.uploadPreviewUrl);
    state.uploadPreviewUrl = null;
    byId("uploadPreview").replaceChildren();
};

const showUpload = (file, status) => {
    clearTimeout(state.uploadHideTimer);
    const panel = byId("uploadPanel");
    panel.hidden = false;
    panel.classList.remove("error");
    byId("uploadStatus").textContent = status;
    byId("uploadProgress").value = 0;
    byId("uploadPreview").replaceChildren();
    if (file?.type.startsWith("image/")) {
        state.uploadPreviewUrl = URL.createObjectURL(file);
        const image = document.createElement("img");
        image.alt = "Attachment preview";
        image.src = state.uploadPreviewUrl;
        byId("uploadPreview").appendChild(image);
    } else {
        const label = document.createElement("span");
        label.textContent = file?.type.startsWith("video/") ? "▶" : file?.type.startsWith("audio/") ? "♫" : "▤";
        byId("uploadPreview").appendChild(label);
    }
};

const hideUpload = () => {
    byId("uploadPanel").hidden = true;
    byId("uploadPanel").classList.remove("error");
    state.uploadRequest = null;
    clearUploadPreview();
};

const sendMultipartPart = async (conversation, uploadId, partNumber, chunk, uploadedBytes, file, onProgress) => {
    const partEndpoint = `/api/messages/${encodeURIComponent(conversation)}/media/multipart/${encodeURIComponent(uploadId)}/parts/${partNumber}`;
    const { url } = await api(`${partEndpoint}/presign`, { method: "POST" });
    const etag = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        state.uploadRequest = request;
        request.open("PUT", url);
        request.withCredentials = false;
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.upload.addEventListener("progress", event => {
            if (!event.lengthComputable) return;
            onProgress(uploadedBytes + Math.min(event.loaded, chunk.size), file.size);
        });
        request.addEventListener("load", () => {
            state.uploadRequest = null;
            if (request.status < 200 || request.status >= 300) {
                reject(new Error("Storage rejected this part. Check the bucket's CORS settings and storage permissions."));
                return;
            }
            const uploadedEtag = request.getResponseHeader("ETag");
            if (!uploadedEtag) {
                reject(new Error("The bucket must expose its ETag response header in CORS settings."));
                return;
            }
            resolve(uploadedEtag);
        });
        request.addEventListener("error", () => {
            state.uploadRequest = null;
            reject(new Error("Network error. Check your connection and try again."));
        });
        request.addEventListener("abort", () => {
            state.uploadRequest = null;
            reject(new Error("Upload canceled"));
        });
        request.send(chunk);
    });
    state.uploadRequest = null;
    await api(`${partEndpoint}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ etag })
    });
};

const uploadLargeFile = async (id, file, uploadKey, clientMessageId) => {
    let uploadId = null;
    state.uploadActive = true;
    state.cancelUploadRequested = false;
    try {
        const started = await api(`/api/messages/${encodeURIComponent(id)}/media/multipart`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileName: file.name, mimeType: file.type, size: file.size, clientMessageId })
        });
        if (started.message) {
            state.pendingUploadIds.delete(uploadKey);
            renderMessage(started.message);
            byId("uploadProgress").value = 100;
            byId("uploadStatus").textContent = "Attachment already sent";
            state.uploadHideTimer = setTimeout(hideUpload, 1800);
            return;
        }

        uploadId = started.uploadId;
        state.multipartUploadId = uploadId;
        const partSize = Number(started.partSize);
        const partCount = Math.ceil(file.size / partSize);
        if (!uploadId || !Number.isSafeInteger(partSize) || partSize <= 0 || !partCount) {
            throw new Error("The server returned an invalid upload session.");
        }

        let uploadedBytes = 0;
        for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
            if (state.cancelUploadRequested) throw new Error("Upload canceled");
            const start = (partNumber - 1) * partSize;
            const end = Math.min(start + partSize, file.size);
            const chunk = file.slice(start, end);
            byId("uploadStatus").textContent = `Uploading ${file.name} · part ${partNumber} of ${partCount}`;
            await sendMultipartPart(id, uploadId, partNumber, chunk, uploadedBytes, file, (current, total) => {
                const percent = Math.min(99, Math.round((current / total) * 100));
                byId("uploadProgress").value = percent;
                byId("uploadStatus").textContent = `Uploading ${file.name} · ${percent}%`;
            });
            uploadedBytes = end;
        }
        if (state.cancelUploadRequested) throw new Error("Upload canceled");

        const result = await api(`/api/messages/${encodeURIComponent(id)}/media/multipart/${encodeURIComponent(uploadId)}/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientMessageId })
        });
        uploadId = null;
        state.multipartUploadId = null;
        state.pendingUploadIds.delete(uploadKey);
        renderMessage(result.message);
        byId("uploadProgress").value = 100;
        byId("uploadStatus").textContent = "Attachment sent";
        state.uploadHideTimer = setTimeout(hideUpload, 1800);
    } catch (error) {
        if (uploadId) {
            await api(`/api/messages/${encodeURIComponent(id)}/media/multipart/${encodeURIComponent(uploadId)}`, {
                method: "DELETE"
            }).catch(() => {});
        }
        byId("uploadPanel").classList.add("error");
        byId("uploadStatus").textContent = error.message || "Upload failed. Try again.";
    } finally {
        state.uploadRequest = null;
        state.uploadActive = false;
        state.cancelUploadRequested = false;
        state.multipartUploadId = null;
    }
};

const uploadFile = file => {
    const id = conversationId();
    if (!file || !id) return;
    if (file.size > MAX_MEDIA_SIZE_BYTES) {
        showUpload(file, "This file is larger than 2 GB.");
        byId("uploadPanel").classList.add("error");
        return;
    }

    const uploadKey = `${id}\u0000${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    const clientMessageId = state.pendingUploadIds.get(uploadKey) || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    state.pendingUploadIds.set(uploadKey, clientMessageId);
    showUpload(file, `Ready to upload · ${formatBytes(file.size)}`);

    if (file.size > MULTIPART_THRESHOLD_BYTES) {
        uploadLargeFile(id, file, uploadKey, clientMessageId);
        return;
    }

    const formData = new FormData();
    formData.append("clientMessageId", clientMessageId);
    formData.append("media", file);
    const request = new XMLHttpRequest();
    state.uploadRequest = request;
    request.open("POST", `/api/messages/${encodeURIComponent(id)}/media`);
    request.withCredentials = true;
    request.upload.addEventListener("progress", event => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        byId("uploadProgress").value = percent;
        byId("uploadStatus").textContent = `Uploading ${file.name} · ${percent}%`;
    });
    request.addEventListener("load", () => {
        state.uploadRequest = null;
        let response = {};
        try { response = JSON.parse(request.responseText); } catch { /* Invalid responses get a readable fallback. */ }
        if (request.status === 401) {
            window.location.href = "/";
            return;
        }
        if (request.status < 200 || request.status >= 300) {
            byId("uploadPanel").classList.add("error");
            byId("uploadStatus").textContent = response.message || "Upload failed. Try again.";
            return;
        }
        state.pendingUploadIds.delete(uploadKey);
        renderMessage(response.message);
        byId("uploadProgress").value = 100;
        byId("uploadStatus").textContent = "Attachment sent";
        state.uploadHideTimer = setTimeout(hideUpload, 1800);
    });
    request.addEventListener("error", () => {
        state.uploadRequest = null;
        byId("uploadPanel").classList.add("error");
        byId("uploadStatus").textContent = "Network error. Check your connection and try again.";
    });
    request.addEventListener("abort", () => {
        state.uploadRequest = null;
        byId("uploadPanel").classList.add("error");
        byId("uploadStatus").textContent = "Upload canceled";
    });
    request.send(formData);
};

attachBtn.addEventListener("click", () => mediaInput.click());
mediaInput.addEventListener("change", () => {
    const [file] = mediaInput.files || [];
    mediaInput.value = "";
    uploadFile(file);
});
byId("cancelUploadBtn").addEventListener("click", () => {
    if (state.uploadRequest) state.uploadRequest.abort();
    else if (state.uploadActive) state.cancelUploadRequested = true;
    else hideUpload();
});

messages.addEventListener("dragover", event => {
    if (!state.conversation || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    messages.classList.add("drag-active");
});
messages.addEventListener("dragleave", event => {
    if (!messages.contains(event.relatedTarget)) messages.classList.remove("drag-active");
});
messages.addEventListener("drop", event => {
    messages.classList.remove("drag-active");
    if (!state.conversation) return;
    event.preventDefault();
    const [file] = event.dataTransfer?.files || [];
    if (event.dataTransfer?.files?.length > 1) setChatStatus("Attach one file at a time.");
    uploadFile(file);
});

const showCall = (title, status, incoming) => {
    const call = state.call;
    if (!call) return;
    clearTimeout(state.closeCallTimer);
    callOverlay.hidden = false;
    byId("callHeading").textContent = title;
    byId("callStatus").textContent = status;
    byId("callAvatar").textContent = (call.peerName || "?").charAt(0).toUpperCase();
    byId("callError").textContent = "";
    byId("callDuration").textContent = "";
    byId("callVideos").classList.toggle("audio-only", call.mode !== "video");
    byId("callCameraBtn").hidden = call.mode !== "video";
    byId("switchCameraBtn").hidden = call.mode !== "video";
    incomingActions.hidden = !incoming;
    activeActions.hidden = incoming;
    updateConversationControls();
};

const friendlyMediaError = error => {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") return "Camera or microphone access was blocked. Allow it in your browser’s site settings, then reload and try again. Calls require HTTPS (or localhost).";
    if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") return "No microphone or camera was found on this device.";
    if (error?.name === "NotReadableError" || error?.name === "TrackStartError") return "The microphone or camera is already in use by another app.";
    if (!navigator.mediaDevices?.getUserMedia) return "Calls need a secure HTTPS connection and a browser with WebRTC support.";
    return "Could not access your microphone or camera. Check browser permissions and try again.";
};

const callErrorMessage = error => {
    if (["NotAllowedError", "SecurityError", "NotFoundError", "DevicesNotFoundError", "NotReadableError", "TrackStartError"].includes(error?.name)) {
        return friendlyMediaError(error);
    }
    return error?.message || friendlyMediaError(error);
};

const createPeerConnection = call => {
    const connection = new RTCPeerConnection({ iceServers: call.iceServers || [{ urls: "stun:stun.l.google.com:19302" }] });
    call.peerConnection = connection;
    call.localStream.getTracks().forEach(track => connection.addTrack(track, call.localStream));
    localVideo.srcObject = call.mode === "video" ? call.localStream : null;

    connection.ontrack = event => {
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        if (call.mode === "video") remoteVideo.srcObject = stream;
        else remoteAudio.srcObject = stream;
        const playback = call.mode === "video" ? remoteVideo : remoteAudio;
        playback.play().catch(() => {
            byId("callError").textContent = "Tap the call window to enable audio playback.";
        });
    };

    connection.onicecandidate = event => {
        if (!event.candidate || !state.socket?.connected) return;
        state.socket.emit("call:candidate", { callId: call.callId, candidate: event.candidate.toJSON() });
    };

    connection.onconnectionstatechange = () => {
        if (state.call !== call) return;
        if (connection.connectionState === "connected") {
            clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
            byId("callStatus").textContent = "Connected";
            startCallDuration();
        } else if (connection.connectionState === "disconnected") {
            byId("callStatus").textContent = "Connection interrupted. Trying to reconnect…";
            scheduleIceRestart(call);
        } else if (connection.connectionState === "failed") {
            scheduleIceRestart(call, true);
        }
    };
    return connection;
};

const applyPendingCandidates = async call => {
    const connection = call.peerConnection;
    const pending = call.pendingCandidates.splice(0);
    for (const candidate of pending) {
        try { await connection.addIceCandidate(candidate); } catch { /* Ignore stale candidates after reconnects. */ }
    }
};

const createAndSendOffer = async (restart = false) => {
    const call = state.call;
    if (!call?.peerConnection) return;
    const offer = await call.peerConnection.createOffer(restart ? { iceRestart: true } : undefined);
    await call.peerConnection.setLocalDescription(offer);
    state.socket.emit("call:offer", { callId: call.callId, description: call.peerConnection.localDescription }, response => {
        if (response?.error) byId("callError").textContent = response.error;
    });
};

const scheduleIceRestart = (call, immediate = false) => {
    if (call.role !== "caller" || call.restartAttempts >= 2 || state.reconnectTimer) {
        if (call.role !== "caller" || call.restartAttempts >= 2) {
            state.reconnectTimer = setTimeout(() => {
                if (state.call === call && call.peerConnection?.connectionState !== "connected") {
                    byId("callError").textContent = "Could not restore the call connection.";
                    endCall("ended", true);
                }
            }, immediate ? 0 : 9000);
        }
        return;
    }
    state.reconnectTimer = setTimeout(async () => {
        state.reconnectTimer = null;
        if (state.call !== call || call.peerConnection?.connectionState === "connected") return;
        call.restartAttempts += 1;
        try {
            call.peerConnection.restartIce();
            await createAndSendOffer(true);
        } catch {
            scheduleIceRestart(call, true);
        }
    }, immediate ? 0 : 3500);
};

const startCallDuration = () => {
    if (state.callDurationTimer) return;
    const started = Date.now();
    state.callDurationTimer = setInterval(() => {
        if (!state.call) return;
        const seconds = Math.floor((Date.now() - started) / 1000);
        const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
        byId("callDuration").textContent = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
    }, 1000);
};

const requestLocalStream = async mode => {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Calls need a secure HTTPS connection and a browser with WebRTC support.");
    }
    return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: mode === "video" ? { facingMode: "user" } : false
    });
};

const startOutgoingCall = async mode => {
    if (!state.conversation || !state.selectedUser || !state.socket?.connected || state.call) return;
    state.callTrigger = document.activeElement;
    const call = state.call = {
        conversationId: conversationId(),
        peerId: getId(state.selectedUser._id),
        peerName: state.selectedUser.username,
        mode,
        role: "caller",
        status: "requesting-media",
        callId: null,
        iceServers: null,
        localStream: null,
        peerConnection: null,
        pendingCandidates: [],
        restartAttempts: 0
    };
    showCall("Starting call…", "Waiting for microphone and camera permissions.", false);
    byId("callEndBtn").focus({ preventScroll: true });
    try {
        const stream = await requestLocalStream(mode);
        if (state.call !== call) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        call.localStream = stream;
        byId("callStatus").textContent = `Calling ${call.peerName}…`;
        const result = await new Promise((resolve, reject) => {
            state.socket.timeout(8000).emit("call:invite", {
                conversationId: call.conversationId,
                targetUserId: call.peerId,
                mode
            }, (timeoutError, response) => timeoutError ? reject(new Error("Could not reach the other person. Try again.")) : response?.error ? reject(new Error(response.error)) : resolve(response));
        });
        if (state.call !== call) {
            if (result?.callId && state.socket?.connected) state.socket.emit("call:end", { callId: result.callId });
            return;
        }
        call.callId = result.callId;
        call.iceServers = result.iceServers;
        createPeerConnection(call);
    } catch (error) {
        if (state.call) {
            byId("callStatus").textContent = "Call could not start";
            byId("callError").textContent = callErrorMessage(error);
            byId("activeActions").hidden = false;
        }
    }
};

const acceptCall = async () => {
    const call = state.call;
    if (!call || call.role !== "callee" || !state.socket?.connected) return;
    byId("callAcceptBtn").disabled = true;
    byId("callStatus").textContent = "Waiting for microphone and camera permissions…";
    try {
        const stream = await requestLocalStream(call.mode);
        if (state.call !== call) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        call.localStream = stream;
        call.iceServers = await new Promise((resolve, reject) => {
            state.socket.timeout(8000).emit("call:accept", { callId: call.callId }, (timeoutError, response) => timeoutError ? reject(new Error("Could not accept this call. Check your connection.")) : response?.error ? reject(new Error(response.error)) : resolve(response.iceServers));
        });
        if (state.call !== call) return;
        call.status = "connecting";
        createPeerConnection(call);
        showCall("Connecting…", "Setting up a secure peer connection.", false);
    } catch (error) {
        byId("callError").textContent = callErrorMessage(error);
        if (state.socket?.connected) state.socket.emit("call:reject", { callId: call.callId });
        byId("callStatus").textContent = "Call declined";
        state.closeCallTimer = setTimeout(() => finishCallUi(), 2600);
    }
};

const clearCallMedia = call => {
    clearInterval(state.callDurationTimer);
    clearTimeout(state.reconnectTimer);
    state.callDurationTimer = null;
    state.reconnectTimer = null;
    if (call?.peerConnection) {
        call.peerConnection.ontrack = null;
        call.peerConnection.onicecandidate = null;
        call.peerConnection.onconnectionstatechange = null;
        call.peerConnection.close();
    }
    call?.localStream?.getTracks().forEach(track => track.stop());
    remoteVideo.srcObject = null;
    localVideo.srcObject = null;
    remoteAudio.srcObject = null;
};

const finishCallUi = message => {
    const call = state.call;
    if (!call) return;
    clearTimeout(state.closeCallTimer);
    clearCallMedia(call);
    state.call = null;
    if (message) {
        byId("callStatus").textContent = message;
        incomingActions.hidden = true;
        activeActions.hidden = true;
        state.closeCallTimer = setTimeout(() => {
            callOverlay.hidden = true;
            updateConversationControls();
            state.callTrigger?.focus?.({ preventScroll: true });
        }, 1350);
    } else {
        callOverlay.hidden = true;
        updateConversationControls();
        state.callTrigger?.focus?.({ preventScroll: true });
    }
};

const endCall = (reason = "ended", notify = true) => {
    const call = state.call;
    if (!call) return;
    call.status = "ended";
    if (notify && call.callId && state.socket?.connected) {
        state.socket.emit(reason === "rejected" ? "call:reject" : "call:end", { callId: call.callId });
    }
    finishCallUi(reason === "rejected" ? "Call declined" : "Call ended");
};

byId("voiceCallBtn").addEventListener("click", () => startOutgoingCall("audio"));
byId("videoCallBtn").addEventListener("click", () => startOutgoingCall("video"));
byId("callAcceptBtn").addEventListener("click", acceptCall);
byId("callRejectBtn").addEventListener("click", () => endCall("rejected", true));
byId("callEndBtn").addEventListener("click", () => endCall("ended", true));

byId("callMicBtn").addEventListener("click", () => {
    const track = state.call?.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    byId("callMicBtn").textContent = track.enabled ? "Mute mic" : "Unmute mic";
    byId("callMicBtn").setAttribute("aria-pressed", String(track.enabled));
});

byId("callCameraBtn").addEventListener("click", () => {
    const track = state.call?.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    byId("callCameraBtn").textContent = track.enabled ? "Turn camera off" : "Turn camera on";
    byId("callCameraBtn").setAttribute("aria-pressed", String(track.enabled));
});

byId("switchCameraBtn").addEventListener("click", async () => {
    const call = state.call;
    if (!call || call.mode !== "video") return;
    const oldTrack = call.localStream.getVideoTracks()[0];
    const facingMode = oldTrack?.getSettings().facingMode === "environment" ? "user" : "environment";
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facingMode } }, audio: false });
        const nextTrack = stream.getVideoTracks()[0];
        const sender = call.peerConnection?.getSenders().find(item => item.track?.kind === "video");
        if (!sender || !nextTrack) throw new Error("Camera switching is not supported on this device.");
        await sender.replaceTrack(nextTrack);
        call.localStream.removeTrack(oldTrack);
        call.localStream.addTrack(nextTrack);
        localVideo.srcObject = call.localStream;
        oldTrack?.stop();
    } catch (error) {
        byId("callError").textContent = error.message || "Could not switch cameras on this device.";
    }
});

document.addEventListener("keydown", event => {
    if (callOverlay.hidden || !state.call) return;
    if (event.key === "Escape") {
        event.preventDefault();
        endCall(state.call.status === "incoming" ? "rejected" : "ended", true);
    }
    if (event.key === "Tab") {
        const focusable = [...callOverlay.querySelectorAll("button:not(:disabled)")]
            .filter(button => !button.closest("[hidden]"));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});

(async () => {
    try {
        const me = await api("/api/auth/me");
        state.currentUser = {
            id: getId(me.user.id),
            username: me.user.username,
            email: me.user.email
        };
        byId("currentUser").textContent = me.user.email;
        await Promise.all([loadConversations(), loadFriendRequests()]);
        renderUsers();
        initSocket();
        window.setInterval(refreshLiveState, 5000);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") refreshLiveState();
        });
    } catch (error) {
        if (error.message !== "Your session has ended. Sign in again.") {
            byId("contactStatus").textContent = error.message || "Could not load people. Refresh to try again.";
        }
    }
})();
