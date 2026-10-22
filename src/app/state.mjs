/** Global client state: session, workspace, capabilities and app metadata. */
export const state = {
  session: null,
  meta: null,
  navBadges: { approvals: 0, inbox: 0, notifications: 0 },
};

export const events = new EventTarget();

export function emit(type, detail = null) {
  events.dispatchEvent(new CustomEvent(type, { detail }));
}

export function setSession(session) {
  state.session = session;
  if (session?.user?.mustChangePassword) state.session.user.mustChangePassword = true;
  emit('session', session);
}

export function clearSession() {
  state.session = null;
  emit('session', null);
}

export function currentUser() {
  return state.session?.user || null;
}

export function currentWorkspace() {
  return state.session?.workspace || null;
}

export function membership() {
  return state.session?.membership || null;
}

export function can(capability) {
  const capabilities = membership()?.capabilities || [];
  return capabilities.includes(capability);
}

export function requireCan(capability) {
  if (can(capability)) return true;
  throw new Error('当前角色没有该操作权限');
}

export function setNavBadges(partial) {
  Object.assign(state.navBadges, partial || {});
  emit('badges', state.navBadges);
}

export function roleLabel() {
  return membership()?.roleLabel || '';
}

export default state;
