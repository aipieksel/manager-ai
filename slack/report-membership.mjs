// Query current channel membership, including later pages. Unknown is denied.
export async function isChannelMember(slack, channel, user) {
  let cursor; const seen = new Set(); const deadline = Date.now() + 12000;
  for (let page = 0; page < 20 && Date.now() < deadline; page++) {
    const result = await slack('conversations.members', {channel, limit:200, ...(cursor ? {cursor} : {})});
    if (!result.ok || !Array.isArray(result.members)) throw new Error('membership_unavailable');
    if (result.members.includes(user)) return true;
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) return false;
    if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error('membership_unavailable');
    seen.add(cursor);
  }
  throw new Error('membership_unavailable');
}
