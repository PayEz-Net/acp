export async function sendMail(storage, msg) {
  return storage.createMessage({
    messageType: 'mail',
    channel: null,
    fromAgent: msg.from,
    toAgent: msg.to,
    subject: msg.subject,
    body: msg.body,
    priority: msg.priority || 'normal',
    keywords: msg.keywords || [],
    createdAt: msg.createdAt || new Date().toISOString(),
  });
}

export async function getInbox(storage, agentName, opts = {}) {
  const filter = { toAgent: agentName, messageType: 'mail', isArchived: false };
  if (opts.unreadOnly) filter.isRead = false;
  return storage.getMessages(filter);
}

export async function getMail(storage, id) {
  return storage.getMessageById(id);
}

export async function markRead(storage, id) {
  await storage.markRead(id);
}

export async function markAllRead(storage, agentName) {
  await storage.markAllRead(agentName);
}

export async function archiveMail(storage, id) {
  await storage.archiveMessage(id);
}

export function priorityOrder(mails) {
  const order = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...mails].sort((a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2));
}
