// Renderer process. No Node/db access here — everything goes through
// `window.api`, exposed by src/preload/preload.js via contextBridge.

const IMG_BASE = 'https://image.tmdb.org/t/p/w342';
// Posters/portraits are TMDB paths, except books/authors (Open Library) which are full URLs.
const imgSrc = (p) => (/^https?:/.test(p || '') ? p : `${IMG_BASE}${p}`);

// ---------------- auth gate ----------------
// The whole app (header + main content) stays hidden until there's a
// signed-in session. Data now lives in Supabase, scoped per account by
// Row Level Security — nothing in the app works without being signed in.

const authEls = {
    page: document.getElementById('authPage'),
    header: document.getElementById('appHeader'),
    main: document.getElementById('appMain'),
    tabs: document.querySelectorAll('.auth-tab'),
    form: document.getElementById('authForm'),
    email: document.getElementById('authEmail'),
    password: document.getElementById('authPassword'),
    submitBtn: document.getElementById('authSubmitBtn'),
    error: document.getElementById('authError'),
    notice: document.getElementById('authNotice'),
    accountAvatarBtn: document.getElementById('accountAvatarBtn'),
    accountAvatarInitial: document.getElementById('accountAvatarInitial'),
    accountMenu: document.getElementById('accountMenu'),
    accountDropdown: document.getElementById('accountDropdown'),
    accountDropdownProfile: document.getElementById('accountDropdownProfile'),
    accountDropdownAccount: document.getElementById('accountDropdownAccount'),
    logoutBtn: document.getElementById('accountDropdownLogout'),
    switchProfileBtn: document.getElementById('accountDropdownSwitch'),
    pickerBackBtn: document.getElementById('pickerBackBtn'),
    pickerPage: document.getElementById('profilePickerPage'),
    pickerGrid: document.getElementById('pickerGrid'),
    pickerError: document.getElementById('pickerError'),
};

let authMode = 'signin';
let authFromPicker = false; // true when "+ Add Account" was clicked from the picker

authEls.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
        authEls.tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        authMode = tab.dataset.mode;
        authEls.submitBtn.textContent = authMode === 'signin' ? 'Log In' : 'Sign Up';
        authEls.error.classList.add('hidden');
        authEls.notice.classList.add('hidden');
    });
});

authEls.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    authEls.error.classList.add('hidden');
    authEls.notice.classList.add('hidden');
    authEls.submitBtn.disabled = true;

    const email = authEls.email.value.trim();
    const password = authEls.password.value;

    try {
        if (authMode === 'signin') {
            await window.api.signIn(email, password);
            showApp();
        } else {
            await window.api.signUp(email, password);
            // Supabase requires email confirmation by default — signUp
            // doesn't hand back an active session in that case.
            authEls.tabs[0].click(); // switch to sign-in tab first (this also clears any notice)
            authEls.notice.textContent = 'Account created — check your email to confirm, then log in.';
            authEls.notice.classList.remove('hidden');
        }
    } catch (err) {
        authEls.error.textContent = err.message;
        authEls.error.classList.remove('hidden');
    } finally {
        authEls.submitBtn.disabled = false;
    }
});

authEls.logoutBtn.addEventListener('click', async () => {
    closeAccountDropdown();
    await window.api.signOut();
    // "Log Out" forgets this profile on this device (see signOut in
    // supabase.js) — if anyone else is still registered here, drop back to
    // the picker rather than a blank login form; otherwise it's the normal
    // fully-signed-out state.
    const remaining = await window.api.listFamilyAccounts();
    remaining.length > 0 ? showProfilePicker() : showAuthPage();
});

authEls.switchProfileBtn.addEventListener('click', () => {
    closeAccountDropdown();
    // Doesn't sign out — the current session stays active until another
    // profile is actually picked (or this one is re-picked).
    showProfilePicker();
});

authEls.pickerBackBtn.addEventListener('click', () => showProfilePicker());

function showAuthPage(fromPicker = false, prefillEmail = null) {
    authFromPicker = fromPicker;
    authEls.pickerBackBtn.classList.toggle('hidden', !fromPicker);
    authEls.page.classList.remove('hidden');
    authEls.pickerPage.classList.add('hidden');
    authEls.header.classList.add('hidden');
    authEls.main.classList.add('hidden');
    if (prefillEmail) {
        authEls.email.value = prefillEmail;
        authEls.email.readOnly = true;
        authEls.password.focus();
    } else {
        authEls.email.readOnly = false;
    }
}

function showApp() {
    authEls.page.classList.add('hidden');
    authEls.pickerPage.classList.add('hidden');
    authEls.header.classList.remove('hidden');
    authEls.main.classList.remove('hidden');
    refreshAccountAvatar();
    profileStale = true; profileMyId = null;
    // A profile switch means totally different account data — nothing
    // cached under the old session is valid anymore.
    invalidateEntriesCache();
    switchSection('home');
    checkForNewEpisodesInBackground();
}

async function refreshAccountAvatar() {
    const session = await window.api.getSession();
    if (!session?.user) return;
    let profile = null;
    try {
        profile = await window.api.getProfile();
    } catch (err) {
        console.error('Failed to load profile:', err);
    }
    const name = profile?.display_name || session.user.email.split('@')[0];
    if (profile?.avatar_url) {
        authEls.accountAvatarBtn.style.background = 'transparent';
        authEls.accountAvatarBtn.innerHTML = `<img src="${profile.avatar_url}" alt="">`;
    } else {
        const color = profile?.avatar_color || colorForId(session.user.id);
        authEls.accountAvatarBtn.style.background = color;
        authEls.accountAvatarBtn.innerHTML = `<span>${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
    }
}

// A small fixed palette (not random) so the same person's tile is always
// the same color across launches — same idea as Netflix's per-profile color,
// just picked from this app's own palette instead of a photo/icon upload.
const PICKER_COLORS = ['#b74b4b', '#4b7ab7', '#4bb78a', '#b7954b', '#8a4bb7', '#4bb0b7'];
function colorForId(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return PICKER_COLORS[hash % PICKER_COLORS.length];
}
function displayNameFor(account) {
    return account.label || account.email.split('@')[0];
}

async function showProfilePicker() {
    authEls.page.classList.add('hidden');
    authEls.header.classList.add('hidden');
    authEls.main.classList.add('hidden');
    authEls.pickerPage.classList.remove('hidden');
    authEls.pickerError.classList.add('hidden');
    await renderPickerGrid();
}

// Merges two sources: the LOCAL device cache (who's actually signed in
// here before — lets a tile switch instantly) with the REAL family roster
// from the server (who's actually allowed to be here at all). Local-only
// history is no longer sufient by itself — see schema.sql's family tables.
async function getPickerRoster() {
    const localAccounts = await window.api.listFamilyAccounts();
    const localById = new Map(localAccounts.map((a) => [a.id, a]));

    const session = await window.api.getSession();
    if (!session) {
        // No authenticated request is possible without an active session,
        // so the best available answer is "whoever's used this device
        // before" — same as before this feature existed.
        return localAccounts.map((a) => ({ ...a, cached: true }));
    }

    let mine = { members: [] };
    try {
        mine = await window.api.listMyFamily();
    } catch (err) {
        console.error('Failed to load family roster:', err);
    }
    if (mine.members.length === 0) {
        // No real family yet (the normal, unremarkable case) — just this
        // account, so initAuthGate won't even route here in practice.
        return [{ id: session.user.id, email: session.user.email, label: localById.get(session.user.id)?.label || null, cached: true }];
    }
    return mine.members.map((m) => {
        const local = localById.get(m.user_id);
        return { id: m.user_id, email: m.email, label: local?.label || null, cached: Boolean(local) };
    });
}

async function renderPickerGrid() {
    const roster = await getPickerRoster();
    authEls.pickerGrid.innerHTML = roster.map((a) => `
        <div class="picker-tile" data-id="${a.id}" data-email="${escapeHtml(a.email)}" data-cached="${a.cached ? '1' : ''}">
            ${a.cached ? `<button type="button" class="picker-remove-btn" data-remove-id="${a.id}" title="Forget on this device">&#10005;</button>` : ''}
            <div class="picker-avatar" style="background:${colorForId(a.id)}">${escapeHtml(displayNameFor(a).charAt(0).toUpperCase())}</div>
            <div class="picker-name">${escapeHtml(displayNameFor(a))}</div>
        </div>
    `).join('') + `
        <div class="picker-tile" data-add="1">
            <div class="picker-avatar picker-avatar--add">+</div>
            <div class="picker-name">Add Account</div>
        </div>
    `;

    authEls.pickerGrid.querySelectorAll('.picker-remove-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await window.api.removeFamilyAccount(btn.dataset.removeId);
            renderPickerGrid();
        });
    });

    authEls.pickerGrid.querySelectorAll('.picker-tile').forEach((tile) => {
        tile.addEventListener('click', async () => {
            if (tile.dataset.add) {
                authEls.form.reset();
                showAuthPage(true);
                return;
            }
            // A real family member who's never signed in on this specific
            // device before has nothing cached to switch to instantly —
            // same one-time password step as adding a new account.
            if (!tile.dataset.cached) {
                authEls.form.reset();
                showAuthPage(true, tile.dataset.email);
                return;
            }
            authEls.pickerError.classList.add('hidden');
            try {
                await window.api.switchFamilyAccount(tile.dataset.id);
                showApp();
            } catch (err) {
                // Stored refresh token has gone stale — fall back to asking
                // that profile to sign in again, same idea as Netflix asking
                // for a PIN when a profile's session has lapsed.
                showAuthPage(true, tile.dataset.email);
            }
        });
    });
}

async function initAuthGate() {
    try {
        await initAuthGateInner();
    } finally {
        document.getElementById('appSplash').classList.add('hidden');
    }
}

async function initAuthGateInner() {
    const session = await window.api.getSession();
    if (session) {
        const mine = await window.api.listMyFamily().catch(() => ({ members: [] }));
        mine.members.length > 1 ? showProfilePicker() : showApp();
        return;
    }
    // No active session — fall back to whatever's cached locally, so
    // re-entering is one click instead of retyping an email. If nothing's
    // cached, this is a normal solo login, no picker involved at all.
    const localAccounts = await window.api.listFamilyAccounts();
    localAccounts.length > 0 ? showProfilePicker() : showAuthPage();
}

// ---------------- account profile page ----------------

const profileEls = {
    page: document.getElementById('profilePage'),
    backBtn: document.getElementById('profileBackBtn'),
    banner: document.getElementById('profileBanner'),
    bannerImg: document.getElementById('profileBannerImg'),
    bannerUploadBtn: document.getElementById('profileBannerUploadBtn'),
    bannerFileInput: document.getElementById('profileBannerFileInput'),
    avatarLarge: document.getElementById('profileAvatarLarge'),
    avatarUploadBtn: document.getElementById('profileAvatarUploadBtn'),
    avatarFileInput: document.getElementById('profileAvatarFileInput'),
    removePhotoBtn: document.getElementById('profileRemovePhotoBtn'),
    colorSwatches: document.getElementById('profileColorSwatches'),
    nameInput: document.getElementById('profileNameInput'),
    nameDisplay: document.getElementById('profileNameDisplay'),
    bioDisplay: document.getElementById('profileBioDisplay'),
    saveBtn: document.getElementById('profileSaveBtn'),
    editBtn: document.getElementById('profileEditBtn'),
    editCancelBtn: document.getElementById('profileEditCancelBtn'),
    editBreadcrumbName: document.getElementById('profileEditBreadcrumbName'),
    editNav: document.getElementById('profileEditNav'),
    bioInput: document.getElementById('profileBioInput'),
    statsRow: document.getElementById('profileStatsRow'),
    switchBtn: document.getElementById('accountDropdownSwitch'),
};

const familyEls = {
    invitesForMe: document.getElementById('familyInvitesForMe'),
    membersList: document.getElementById('familyMembersList'),
    sentInvites: document.getElementById('familySentInvites'),
    inviteEmail: document.getElementById('familyInviteEmail'),
    inviteBtn: document.getElementById('familyInviteBtn'),
    setup: document.getElementById('familySetup'),
    manage: document.getElementById('familyManage'),
    setupCreateBtn: document.getElementById('familySetupCreateBtn'),
    setupJoinBtn: document.getElementById('familySetupJoinBtn'),
    createForm: document.getElementById('familyCreateForm'),
    joinInfo: document.getElementById('familyJoinInfo'),
    nameInput: document.getElementById('familyNameInput'),
    createCancelBtn: document.getElementById('familyCreateCancelBtn'),
    createConfirmBtn: document.getElementById('familyCreateConfirmBtn'),
    nameDisplay: document.getElementById('familyNameDisplay'),
    nameEditInput: document.getElementById('familyNameEditInput'),
    nameEditBtn: document.getElementById('familyNameEditBtn'),
    nameSaveBtn: document.getElementById('familyNameSaveBtn'),
};

let profileSelectedColor = null;
let profileAvatarUrl = null;
let profileBannerUrl = null;

// Drag-to-reorder for a row/grid of poster cards (cards come from renderPosterGrid, in item order).
function wireSortablePosters(container, items, onChange) {
    let dragged = null;
    const cards = [...container.querySelectorAll('.poster-card')];
    cards.forEach((card, i) => {
        card.dataset.sortIndex = String(i);
        card.setAttribute('draggable', 'true');
        card.classList.add('sortable-card');
        card.querySelector('img')?.setAttribute('draggable', 'false');
        card.addEventListener('dragstart', (e) => {
            dragged = card; card.classList.add('dragging');
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            dragged = null;
            const order = [...container.querySelectorAll('.poster-card')].map((c) => items[Number(c.dataset.sortIndex)]);
            onChange(order);
        });
    });
    container.ondrop = (e) => e.preventDefault();
    container.addEventListener('dragover', (e) => {
        if (!dragged) return;
        e.preventDefault();
        const over = [...container.querySelectorAll('.poster-card:not(.dragging)')].find((c) => {
            const r = c.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        });
        if (!over) return;
        const r = over.getBoundingClientRect();
        container.insertBefore(dragged, e.clientX < r.left + r.width / 2 ? over : over.nextSibling);
    });
}

let profileStale = true;
async function openProfilePage(opts = {}) {
    // Already loaded and nothing changed since (no entry writes, list edits or profile edits) — just show it.
    if (!profileStale && !entriesCacheDirty && profileMyId && opts.recordHistory !== false) {
        pushNav(currentView);
        currentView = { type: 'profile' };
        showPage('profile');
        return;
    }
    if (opts.recordHistory === false) profileStale = true;
    // Cover the page with a loading screen until its data is in — otherwise it
    // shows half-empty, stale content while everything loads.
    syncHeaderHeight();
    profileEls.page.classList.add('profile-loading');
    try { await openProfilePageInner(opts); }
    finally { profileEls.page.classList.remove('profile-loading'); }
}

let profileMyId = null;
let profileListsCache = null;
let profilePeopleCache = [];
let profileStudiosCache = null; // null = not loaded; [] = none
const profileRoleCache = {};
const profileGenderCache = {};
try {
    const saved = JSON.parse(localStorage.getItem('iveAlready.roles') || '{}');
    Object.entries(saved).forEach(([id, v]) => { profileRoleCache[id] = v.d; profileGenderCache[id] = v.g; });
} catch { /* no saved roles */ }
function saveRoleCache() {
    try {
        const out = {};
        Object.keys(profileRoleCache).forEach((id) => { out[id] = { d: profileRoleCache[id], g: profileGenderCache[id] }; });
        localStorage.setItem('iveAlready.roles', JSON.stringify(out));
    } catch { /* storage unavailable */ }
}
let profileNetCache = {};
function prefetchProfileNetwork() {
    loadFollowedRoles(profilePeopleCache);
    ['following', 'followers'].forEach((k) => {
        window.api.listNetwork(k).then((m) => { profileNetCache[k] = m; }).catch(() => {});
    });
}
function paintProfileMeta(location, xHandle) {
    const el = document.getElementById('profileMetaLine');
    const x = (xHandle || '').replace(/^@/, '').trim();
    el.innerHTML = [
        location ? `<span class="profile-meta-item"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s7-6.5 7-12a7 7 0 10-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>${escapeHtml(location)}</span>` : '',
        x ? `<span class="profile-meta-item"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L2 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.3 4.7H5.5l11.2 14.5z"/></svg>${escapeHtml(x)}</span>` : '',
    ].join('');
}
const profileMenuBtn = document.getElementById('profileMenuBtn');
const profileMenu = document.getElementById('profileMenu');
profileMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); profileMenu.classList.toggle('hidden'); });
document.addEventListener('click', () => profileMenu.classList.add('hidden'));
profileMenu.addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'copy') {
        try { await navigator.clipboard.writeText(`iveAlready://profile/${profileMyId}`); showToast('Profile link copied'); }
        catch { showToast("Couldn't copy the link", true); }
    }
});

let profileSocial = { lists: 0, following: 0, followers: 0 };
let profileFavOrder = { listId: null, items: [] };
async function openProfilePageInner({ recordHistory = true } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'profile' };
    showPage('profile');

    const [session, profile, allEntries, favOrder, myLists, followCounts, followedPeople, followedStudios] = await Promise.all([
        window.api.getSession(),
        window.api.getProfile().catch(() => null),
        getAllEntriesCached().catch(() => []),
        window.api.getFavoritesOrder().catch(() => ({ listId: null, items: [] })),
        window.api.listMyLists().catch(() => []),
        window.api.getFollowCounts().catch(() => ({ following: 0, followers: 0 })),
        window.api.listFollowedPeople().catch(() => []),
        window.api.listFollowedStudios().catch(() => []),
    ]);
    profileStudiosCache = followedStudios || [];
    profileListsCache = myLists || [];
    profilePeopleCache = followedPeople || [];
    profileNetCache = {};
    prefetchProfileNetwork();
    profileSocial = { lists: (myLists || []).length, following: (followCounts?.following || 0) + (followedPeople || []).length + (followedStudios || []).length, followers: followCounts?.followers || 0 };
    profileFavOrder = favOrder || { listId: null, items: [] };
    if (!session?.user) return;

    const displayName = profile?.display_name || session.user.email.split('@')[0];
    profileSelectedColor = profile?.avatar_color || colorForId(session.user.id);
    profileAvatarUrl = profile?.avatar_url || null;
    profileBannerUrl = profile?.banner_url || null;

    profileEls.nameInput.value = displayName;
    profileEls.nameDisplay.textContent = displayName;
    profileEls.editBreadcrumbName.textContent = displayName;
    profileEls.bioInput.value = profile?.bio || '';
    document.getElementById('profileLocationInput').value = profile?.location || '';
    document.getElementById('profileXInput').value = profile?.x_handle || '';
    profileMyId = session.user.id;
    paintProfileMeta(profile?.location, profile?.x_handle);
    profileEls.bioDisplay.textContent = profile?.bio || '';
    setProfileEditMode(false); // always land on the public-facing view first
    paintProfileAvatar(displayName);
    paintProfileBanner();

    profileEls.colorSwatches.innerHTML = PICKER_COLORS.map((c) => `
        <div class="profile-avatar-swatch${c === profileSelectedColor ? ' active' : ''}" style="background:${c}" data-color="${c}"></div>
    `).join('');
    profileEls.colorSwatches.querySelectorAll('.profile-avatar-swatch').forEach((sw) => {
        sw.addEventListener('click', () => {
            profileSelectedColor = sw.dataset.color;
            profileEls.colorSwatches.querySelectorAll('.profile-avatar-swatch').forEach((s) => s.classList.remove('active'));
            sw.classList.add('active');
            paintProfileAvatar(profileEls.nameInput.value || displayName);
        });
    });

    profileAllEntries = allEntries;
    profileStale = false;
    renderProfileTab(profileActiveTab);
}

// The profile page has two modes: the default VIEW mode (what anyone else
// would see) and EDIT mode, opened by the Edit Profile button — laid out
// like Steam's Edit Profile page, with a section sidebar.
function setProfileEditMode(editing) {
    profileEls.page.classList.toggle('editing', editing);
    if (editing) setProfileEditSection('general'); // always re-open on the first section
}

function setProfileEditSection(section) {
    profileEls.editNav.querySelectorAll('.profile-edit-nav-item').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });
    profileEls.editNav.parentElement.querySelectorAll('.profile-edit-section').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.section === section);
    });
}
profileEls.editNav.querySelectorAll('.profile-edit-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setProfileEditSection(btn.dataset.section));
});

// ---------------- account settings page ----------------

const accountPageEls = {
    page: document.getElementById('accountPage'),
    backBtn: document.getElementById('accountBackBtn'),
    breadcrumbName: document.getElementById('accountPageBreadcrumbName'),
    nav: document.getElementById('accountSettingsNav'),
    detailsEmail: document.getElementById('accountDetailsEmail'),
    changeEmailBtn: document.getElementById('accountChangeEmailBtn'),
    changeEmailForm: document.getElementById('accountChangeEmailForm'),
    newEmailInput: document.getElementById('accountNewEmailInput'),
    changeEmailCancelBtn: document.getElementById('accountChangeEmailCancelBtn'),
    changeEmailConfirmBtn: document.getElementById('accountChangeEmailConfirmBtn'),
    changePasswordBtn: document.getElementById('accountChangePasswordBtn'),
    changePasswordForm: document.getElementById('accountChangePasswordForm'),
    newPasswordInput: document.getElementById('accountNewPasswordInput'),
    oldPasswordInput: document.getElementById('accountOldPasswordInput'),
    confirmPasswordInput: document.getElementById('accountConfirmPasswordInput'),
    changePasswordCancelBtn: document.getElementById('accountChangePasswordCancelBtn'),
    changePasswordConfirmBtn: document.getElementById('accountChangePasswordConfirmBtn'),
};

function setAccountSection(section) {
    accountPageEls.nav.querySelectorAll('.profile-edit-nav-item').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });
    accountPageEls.nav.parentElement.querySelectorAll('.profile-edit-section').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.section === section);
    });
    closeAccountInlineForms();
    if (section === 'family') loadFamilySection(); // only needed once that panel is actually visible
}
accountPageEls.nav.querySelectorAll('.profile-edit-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setAccountSection(btn.dataset.section));
});

// Everything under Account Details / Security / Notifications / Data is a
// visual placeholder for now — no backend behind these buttons yet.
document.querySelectorAll('.account-placeholder-btn').forEach((btn) => {
    btn.addEventListener('click', () => showToast("This isn't wired up yet"));
});

async function openAccountPage({ recordHistory = true } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'account' };
    showPage('account');

    const [session, profile] = await Promise.all([
        window.api.getSession(),
        window.api.getProfile().catch(() => null),
    ]);
    if (!session?.user) return;

    accountPageEls.breadcrumbName.textContent = profile?.display_name || session.user.email.split('@')[0];
    accountPageEls.detailsEmail.textContent = session.user.email;
    setAccountSection('details'); // always re-open on the first section
}

accountPageEls.backBtn.addEventListener('click', goBack);

function closeAccountInlineForms() {
    accountPageEls.changeEmailForm.classList.add('hidden');
    accountPageEls.changePasswordForm.classList.add('hidden');
    accountPageEls.newEmailInput.value = '';
    accountPageEls.oldPasswordInput.value = '';
    accountPageEls.newPasswordInput.value = '';
    accountPageEls.confirmPasswordInput.value = '';
}

accountPageEls.changeEmailBtn.addEventListener('click', () => {
    accountPageEls.changePasswordForm.classList.add('hidden');
    accountPageEls.changeEmailForm.classList.toggle('hidden');
    if (!accountPageEls.changeEmailForm.classList.contains('hidden')) accountPageEls.newEmailInput.focus();
});
accountPageEls.changeEmailCancelBtn.addEventListener('click', closeAccountInlineForms);
accountPageEls.changeEmailConfirmBtn.addEventListener('click', async () => {
    const newEmail = accountPageEls.newEmailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        showToast('Enter a valid email address', true);
        return;
    }
    accountPageEls.changeEmailConfirmBtn.disabled = true;
    try {
        await window.api.updateEmail(newEmail);
        showToast(`Confirmation link sent to ${newEmail}`);
        closeAccountInlineForms();
    } catch (err) {
        showToast(`Couldn't update email: ${err.message}`, true);
    } finally {
        accountPageEls.changeEmailConfirmBtn.disabled = false;
    }
});

accountPageEls.changePasswordBtn.addEventListener('click', () => {
    accountPageEls.changeEmailForm.classList.add('hidden');
    accountPageEls.changePasswordForm.classList.toggle('hidden');
    if (!accountPageEls.changePasswordForm.classList.contains('hidden')) accountPageEls.newPasswordInput.focus();
});
accountPageEls.changePasswordCancelBtn.addEventListener('click', closeAccountInlineForms);
accountPageEls.changePasswordConfirmBtn.addEventListener('click', async () => {
    const oldPw = accountPageEls.oldPasswordInput.value;
    const pw = accountPageEls.newPasswordInput.value;
    const confirmPw = accountPageEls.confirmPasswordInput.value;
    if (!oldPw) {
        showToast('Enter your current password', true);
        return;
    }
    if (pw.length < 6) {
        showToast('New password must be at least 6 characters', true);
        return;
    }
    if (pw !== confirmPw) {
        showToast("Passwords don't match", true);
        return;
    }
    accountPageEls.changePasswordConfirmBtn.disabled = true;
    try {
        // Supabase's updateUser() doesn't ask for the current password on
        // its own — re-authenticating with it first is what actually
        // enforces "you must know the old one" before swapping it out.
        const session = await window.api.getSession();
        try {
            await window.api.signIn(session.user.email, oldPw);
        } catch {
            showToast('Current password is incorrect', true);
            return;
        }
        await window.api.updatePassword(pw);
        showToast('Password updated');
        closeAccountInlineForms();
    } catch (err) {
        showToast(`Couldn't update password: ${err.message}`, true);
    } finally {
        accountPageEls.changePasswordConfirmBtn.disabled = false;
    }
});

let profileAllEntries = [];
let profileActiveTab = 'overview';
let profileFilmsFilter = { search: '', decade: null, genre: null, sort: 'last_watched', ascending: false, expanded: false };
let profileSeriesFilter = { search: '', decade: null, genre: null, sort: 'last_watched', ascending: false, expanded: false };
let profileBooksFilter = { search: '', decade: null, genre: null, sort: 'last_watched', ascending: false, expanded: false };
let profileGamesFilter = { search: '', decade: null, genre: null, sort: 'last_watched', ascending: false, expanded: false };
let profileShortsFilter = { search: '', decade: null, genre: null, sort: 'last_watched', ascending: false, expanded: false };

// Shared by the Films and Series sections on the profile's "films" tab —
// same header/filter row markup, only the id prefix differs.
// Remembers each row's chosen sort + direction across launches.
const VIEW_PREFS_KEY = 'iveAlready.viewPrefs';
const viewPrefsApplied = new Set();
function viewPrefsLoad() { try { return JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) || '{}'); } catch { return {}; } }
function applyViewPrefs(key, state) {
    if (viewPrefsApplied.has(key)) return;
    viewPrefsApplied.add(key);
    const saved = viewPrefsLoad()[key];
    if (saved && typeof saved.sort === 'string') { state.sort = saved.sort; state.ascending = !!saved.ascending; }
}
function saveViewPrefs(key, state) {
    try {
        const all = viewPrefsLoad();
        all[key] = { sort: state.sort, ascending: state.ascending };
        localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(all));
    } catch { /* storage unavailable */ }
}

function profileMediaSectionMarkup(prefix) {
    return `
        <div class="poster-row-header">
            <h3 id="${prefix}Count"></h3>
            <div class="poster-row-header-controls">
                <div class="library-search-wrap profile-filter-search">
                    <svg class="library-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                    <input type="text" id="${prefix}Search" class="library-search-input" placeholder="Search…">
                </div>
                <div id="${prefix}Decade"></div>
                <div id="${prefix}Genre"></div>
                <div class="sort-control-group">
                    <div id="${prefix}Sort"></div>
                    <button type="button" id="${prefix}SortDir" class="sort-direction-btn" title="Descending (click for ascending)">
                        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 4v16M12 20l-5-5M12 20l5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                </div>
                <button type="button" id="${prefix}ViewAll" class="view-all-btn" style="display:none;">View All</button>
            </div>
        </div>
        <div class="poster-grid" id="${prefix}Grid"></div>
        <p class="profile-tab-empty" id="${prefix}Empty" style="display:none;"></p>
    `;
}

// Wires up the filter row for one profileMediaSectionMarkup instance —
// search, decade, genre, sort, and sort direction all live-filter `items`.
function setupProfileMediaSection({ prefix, label, items, filterState, sortOptions, emptyText }) {
    applyViewPrefs(prefix, filterState);
    const allGenres = [...new Set(items.flatMap((e) => { try { return JSON.parse(e.genres || '[]'); } catch { return []; } }))].sort();
    const countEl = document.getElementById(`${prefix}Count`);
    const gridEl = document.getElementById(`${prefix}Grid`);
    const emptyEl = document.getElementById(`${prefix}Empty`);
    const viewAllBtn = document.getElementById(`${prefix}ViewAll`);
    countEl.textContent = label; // static section label — the live count now lives in the profile stats row up top

    if (items.length === 0) {
        gridEl.style.display = 'none';
        viewAllBtn.style.display = 'none';
        emptyEl.textContent = emptyText || `No ${label.toLowerCase()} watched yet.`;
        emptyEl.style.display = '';
        return; // nothing to filter/sort/paginate — same empty state other profile tabs use
    }

    viewAllBtn.addEventListener('click', () => {
        filterState.expanded = !filterState.expanded;
        refresh();
    });

    const refresh = () => {
        let filtered = items;
        if (filterState.search) {
            const q = filterState.search.toLowerCase();
            filtered = filtered.filter((e) => (e.title || '').toLowerCase().includes(q));
        }
        if (filterState.decade != null) filtered = filtered.filter((e) => decadeOf(e.release_date) === filterState.decade);
        if (filterState.genre) {
            filtered = filtered.filter((e) => { try { return JSON.parse(e.genres || '[]').includes(filterState.genre); } catch { return false; } });
        }
        const sorted = [...filtered];
        const badgeCriterion = { alphabetical: 'alphabetical', release_date: 'release_date', rating: 'rating' }[filterState.sort] || 'last_watched';
        switch (filterState.sort) {
            case 'alphabetical': sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
            case 'release_date': sorted.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '')); break;
            case 'rating': sorted.sort((a, b) => (a.rating ?? -1) - (b.rating ?? -1)); break;
            case 'platform_rating': sorted.sort((a, b) => (a.imdb_rating ?? -1) - (b.imdb_rating ?? -1)); break;
            case 'runtime': sorted.sort((a, b) => (a.runtime ?? -1) - (b.runtime ?? -1)); break;
            case 'seasons': sorted.sort((a, b) => (a.number_of_seasons ?? -1) - (b.number_of_seasons ?? -1)); break;
            default: sorted.sort((a, b) => watchActivityKey(a) - watchActivityKey(b)); break;
        }
        if (!filterState.ascending) sorted.reverse();
        // Cap to exactly 2 rows, computed from how many 160px poster columns
        // actually fit the grid's current width — a fixed item count would
        // show a different number of rows depending on window/screen size.
        const colWidth = 160, gap = 20; // must match .poster-grid's column width + gap in app.css
        const cols = Math.max(1, Math.floor((gridEl.clientWidth + gap) / (colWidth + gap)));
        const twoRowCap = cols * 2;
        const over = sorted.length > twoRowCap;
        viewAllBtn.style.display = over ? '' : 'none';
        viewAllBtn.textContent = filterState.expanded ? 'Show Less' : 'View All';
        const display = (over && !filterState.expanded) ? sorted.slice(0, twoRowCap) : sorted;
        renderPosterGrid(gridEl, display, badgeCriterion);
    };

    const searchInput = document.getElementById(`${prefix}Search`);
    searchInput.placeholder = `Search ${label.toLowerCase()}…`;
    searchInput.value = filterState.search || '';
    searchInput.addEventListener('input', (e) => { filterState.search = e.target.value.trim(); refresh(); });

    createCustomSelect({
        container: document.getElementById(`${prefix}Decade`),
        options: [{ value: '', label: 'Any Decade' }, ...Array.from({ length: 14 }, (_, i) => {
            const d = 2020 - i * 10;
            return { value: String(d), label: `${d}s` };
        })],
        value: filterState.decade != null ? String(filterState.decade) : '',
        onChange: (v) => { filterState.decade = v ? Number(v) : null; refresh(); },
    });
    createCustomSelect({
        container: document.getElementById(`${prefix}Genre`),
        options: [{ value: '', label: 'Any Genre' }, ...allGenres.map((g) => ({ value: g, label: g }))],
        value: filterState.genre || '',
        onChange: (v) => { filterState.genre = v || null; refresh(); },
    });
    createCustomSelect({
        container: document.getElementById(`${prefix}Sort`),
        options: sortOptions,
        value: filterState.sort,
        onChange: (v) => { filterState.sort = v; saveViewPrefs(prefix, filterState); refresh(); },
    });
    const dirBtn = document.getElementById(`${prefix}SortDir`);
    dirBtn.classList.toggle('ascending', filterState.ascending);
    dirBtn.onclick = () => {
        filterState.ascending = !filterState.ascending;
        saveViewPrefs(prefix, filterState);
        dirBtn.classList.toggle('ascending', filterState.ascending);
        refresh();
    };
    refresh();
}

// Search icon at the end of the tabs: filters THIS profile's reviews and lists.
(function wireProfileSearch() {
    const wrap = document.getElementById('profileTabSearch');
    const input = document.getElementById('profileSearchInput');
    const btn = document.getElementById('profileSearchBtn');
    let timer;
    const close = () => { wrap.classList.remove('open'); input.value = ''; renderProfileTab(profileActiveTab); };
    btn.addEventListener('click', () => {
        if (wrap.classList.contains('open') && !input.value) { close(); return; }
        wrap.classList.add('open');
        input.focus();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            const q = input.value.trim().toLowerCase();
            if (!q) { renderProfileTab(profileActiveTab); return; }
            renderProfileSearchResults(q);
        }, 150);
    });
})();
function renderProfileSearchResults(q) {
    const container = document.getElementById('profileTabContent');
    const reviews = profileAllEntries.filter((e) => e.review && e.review.trim()
        && (e.review.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q)));
    const lists = (profileListsCache || []).filter((l) => (l.name || '').toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q));
    container.innerHTML = `
        <div class="profile-tab-section"><h3>Reviews (${reviews.length})</h3>
            ${reviews.length ? reviews.map((e) => `
                <div class="profile-search-review" data-tmdb-id="${e.tmdb_id}" data-media-type="${e.media_type}">
                    <img src="${e.poster_url || (e.poster_path ? imgSrc(e.poster_path) : '')}" alt="" loading="lazy">
                    <div><div class="profile-list-name">${escapeHtml(e.title)}</div>
                    <div class="profile-list-desc">${escapeHtml(e.review.length > 220 ? e.review.slice(0, 220) + '…' : e.review)}</div></div>
                </div>`).join('') : '<p class="profile-tab-empty">No matching reviews.</p>'}
        </div>
        <div class="profile-tab-section"><h3>Lists (${lists.length})</h3>
            <div id="profileSearchLists">${lists.length ? profileListRowsHtml(lists) : '<p class="profile-tab-empty">No matching lists.</p>'}</div>
        </div>`;
    container.querySelectorAll('.profile-search-review').forEach((r) => r.addEventListener('click', () => openDetails(Number(r.dataset.tmdbId), r.dataset.mediaType)));
    wireProfileListRows(container);
}

function switchProfileTab(tab) {
    document.getElementById('profileTabSearch')?.classList.remove('open');
    const si = document.getElementById('profileSearchInput'); if (si) si.value = '';
    profileActiveTab = tab;
    document.querySelectorAll('.profile-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    renderProfileTab(tab);
}
document.getElementById('profileTabs').querySelectorAll('.profile-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchProfileTab(btn.dataset.tab));
});
// Every number in the banner opens its matching tab.
profileEls.statsRow.addEventListener('click', (e) => {
    const stat = e.target.closest('[data-goto]');
    if (!stat) return;
    const goto = stat.dataset.goto;
    if (goto === 'following' || goto === 'followers') { profileNetworkTab = goto; switchProfileTab('network'); }
    else switchProfileTab(goto);
});

// ---------- rate + like straight from a poster grid ----------
function decoratePosterRateBars(container, items) {
    const byKey = {};
    items.forEach((e) => { byKey[`${e.tmdb_id}:${e.media_type}`] = e; });
    container.querySelectorAll('.poster-card').forEach((card) => {
        const entry = byKey[`${card.dataset.tmdbId}:${card.dataset.mediaType}`];
        if (!entry || card.querySelector('.poster-rate-bar')) return;
        const bar = document.createElement('div');
        bar.className = 'poster-rate-bar';
        const paint = () => {
            const r = entry.is_favorite ? 0 : (entry.rating || 0);
            bar.innerHTML = `<span class="prb-stars">${[0, 1, 2, 3, 4].map((i) => {
                const pts = Math.max(0, Math.min(2, r - i * 2));
                return `<span class="prb-star" data-i="${i}"><span class="prb-star-bg">★</span><span class="prb-star-fill" style="width:${pts * 50}%">★</span></span>`;
            }).join('')}</span><button type="button" class="prb-heart${entry.is_favorite ? ' on' : ''}" title="Like">&#9829;</button>`;
        };
        const save = async (fields) => {
            try {
                const saved = await upsertEntryAndInvalidate(entry.media_id, fields);
                Object.assign(entry, fields, saved ? { rating: saved.rating, is_favorite: saved.is_favorite } : {});
            } catch (err) { showToast(`Couldn't save: ${err.message}`, true); }
            paint();
        };
        bar.addEventListener('click', (e) => {
            e.stopPropagation();
            const heart = e.target.closest('.prb-heart');
            const star = e.target.closest('.prb-star');
            if (heart) {
                const next = !entry.is_favorite;
                save(next ? { is_favorite: true, rating: null } : { is_favorite: false });
            } else if (star) {
                const rect = star.getBoundingClientRect();
                const value = Number(star.dataset.i) * 2 + ((e.clientX - rect.left) > rect.width / 2 ? 2 : 1);
                save(entry.rating === value && !entry.is_favorite ? { rating: null } : { rating: value, is_favorite: false });
            }
        });
        paint();
        card.appendChild(bar);
    });
}

// ---------- Lists tab ----------
function profileListRowsHtml(lists) {
    return lists.map((l) => {
        const posters = l.preview_posters || [];
        return `
        <div class="profile-list-row" data-list-id="${l.id}">
            <div class="profile-list-pile">${posters.length ? posters.map((p, i) => `<img src="${imgSrc(p)}" alt="" style="z-index:${posters.length - i}" loading="lazy">`).join('') : '<div class="profile-list-pile-empty"></div>'}</div>
            <div class="profile-list-info">
                <div class="profile-list-name">${escapeHtml(l.name)}</div>
                <div class="profile-list-meta">${l.item_count || 0} ${l.item_count === 1 ? 'title' : 'titles'}${l.like_count ? ` · <span class="list-card-likes">&#9829; ${l.like_count}</span>` : ''}</div>
                ${l.description ? `<div class="profile-list-desc">${escapeHtml(l.description)}</div>` : ''}
            </div>
        </div>`;
    }).join('');
}
function wireProfileListRows(container) {
    container.querySelectorAll('.profile-list-row').forEach((row) => {
        row.addEventListener('click', () => openListFromAnywhere(row.dataset.listId));
    });
}
async function renderProfileListsTab(container) {
    container.innerHTML = '<div class="profile-tab-section"><h3>Lists</h3><div id="profileListsRows"></div></div>';
    const paint = (lists) => {
        const rows = document.getElementById('profileListsRows');
        if (!rows) return;
        rows.innerHTML = lists.length ? profileListRowsHtml(lists) : '<p class="profile-tab-empty">No lists yet.</p>';
        wireProfileListRows(rows);
    };
    if (profileListsCache) paint(profileListsCache); // instant — fetched when the profile opened
    else {
        try { profileListsCache = await window.api.listMyLists(); } catch (err) { console.error(err); profileListsCache = []; }
        if (profileActiveTab === 'lists') paint(profileListsCache);
    }
}

// ---------- Likes tab ----------
let profileLikesSub = 'films';
let profileLikesFilter = { search: '', decade: null, genre: null, sort: 'last_watched', ascending: false, expanded: false };
function renderProfileLikesTab(container) {
    container.innerHTML = `
        <div class="stats-switcher">
            <button type="button" data-sub="films" class="stats-switch-btn${profileLikesSub === 'films' ? ' active' : ''}">Films</button>
            <button type="button" data-sub="lists" class="stats-switch-btn${profileLikesSub === 'lists' ? ' active' : ''}">Lists</button>
        </div>
        <div id="profileLikesBody"></div>`;
    container.querySelectorAll('.stats-switcher button').forEach((b) => b.addEventListener('click', () => { profileLikesSub = b.dataset.sub; renderProfileLikesTab(container); }));
    const body = document.getElementById('profileLikesBody');
    if (profileLikesSub === 'films') {
        const liked = profileAllEntries.filter((e) => e.is_favorite && (e.media_type === 'movie' || e.media_type === 'tv'));
        body.innerHTML = `<div class="profile-tab-section">${profileMediaSectionMarkup('profileLikes')}</div>`;
        setupProfileMediaSection({
            prefix: 'profileLikes', label: 'Liked', items: liked, filterState: profileLikesFilter,
            emptyText: 'No liked titles yet — tap a heart under any poster.',
            sortOptions: [
                { value: 'last_watched', label: 'Last Watched' },
                { value: 'alphabetical', label: 'Alphabetical' },
                { value: 'release_date', label: 'Release Date' },
                { value: 'platform_rating', label: 'Platform Rating' },
                { value: 'runtime', label: 'Film Length' },
            ],
        });
    } else {
        body.innerHTML = '<div class="profile-tab-section"><h3>Liked Lists</h3><div id="profileLikedLists"><div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div></div></div>';
        window.api.listLikedLists().then((lists) => {
            if (profileActiveTab !== 'likes' || profileLikesSub !== 'lists') return;
            const rows = document.getElementById('profileLikedLists');
            rows.innerHTML = lists.length ? profileListRowsHtml(lists) : '<p class="profile-tab-empty">No liked lists yet.</p>';
            wireProfileListRows(rows);
        }).catch(() => {});
    }
}

// ---------- Network tab ----------
let profileNetworkTab = 'following';
let profileNetworkQuery = '';
function memberRowHtml(m) {
    const initial = escapeHtml((m.display_name || '?').charAt(0).toUpperCase());
    const avatar = m.is_official ? '<img src="assets/official-icon.png" alt="">' : m.avatar_url
        ? `<img src="${m.avatar_url}" alt="">`
        : `<span>${initial}</span>`;
    return `
    <div class="member-row" data-id="${m.id}">
        <div class="member-avatar" style="background:${m.is_official ? '#111' : (m.avatar_color || colorForId(m.id))}">${avatar}</div>
        <div class="member-info">
            <div class="member-name${m.is_official ? ' member-name--link' : ''}">${escapeHtml(m.display_name || 'Member')}${m.is_official ? ' <span class="list-hq-badge">HQ</span>' : ''}</div>
            <div class="member-sub">${m.is_official ? 'Official account' : 'Member'} · ${m.followers} follower${m.followers === 1 ? '' : 's'}, following ${m.following}</div>
        </div>
        <button type="button" class="member-follow-btn${m.i_follow ? ' following' : ''}">${m.i_follow ? 'FOLLOWING' : 'FOLLOW'}</button>
    </div>`;
}
function wireMemberRows(container, members, onChange) {
    container.querySelectorAll('.member-row:not(.person-row)').forEach((row) => {
        const m = members.find((x) => x.id === row.dataset.id);
        if (!m) return;
        const btn = row.querySelector('.member-follow-btn');
        if (m.is_official) row.querySelector('.member-name').addEventListener('click', () => openOfficialAccountPage());
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                if (m.i_follow) { await window.api.unfollowUser(m.id); m.i_follow = false; profileSocial.following = Math.max(0, profileSocial.following - 1); }
                else { await window.api.followUser(m.id); m.i_follow = true; profileSocial.following += 1; }
                btn.textContent = m.i_follow ? 'FOLLOWING' : 'FOLLOW';
                btn.classList.toggle('following', m.i_follow);
                renderProfileStatsRow('overview');
                profileNetCache = {};
                onChange?.();
            } catch (err) { showToast(`Couldn't update follow: ${err.message}`, true); }
            finally { btn.disabled = false; }
        });
    });
}
let profileFollowingFilter = 'all'; // all | people | members
let profileFollowingSort = 'role';
let profileFollowingView = 'list';
function roleLabel(r, gender) {
    if (r === 'Acting') return gender === 1 ? 'Actress' : 'Actor';
    return ({ Acting: 'Actor', Directing: 'Director', Writing: 'Writer', Production: 'Producer', Camera: 'Cinematographer', Editing: 'Editor', Sound: 'Sound', Art: 'Art Department', Crew: 'Crew', 'Visual Effects': 'Visual Effects', 'Costume & Make-Up': 'Costume & Make-Up' })[r] || r || '';
}
function personRowHtml(p) {
    const role = profileRoleCache[p.tmdb_person_id] || '';
    return `
    <div class="member-row person-row" data-person-id="${p.tmdb_person_id}">
        <div class="member-avatar person-avatar">${p.profile_path ? `<img src="${imgSrc(p.profile_path)}" alt="">` : `<span>${escapeHtml((p.person_name || '?').charAt(0))}</span>`}</div>
        <div class="member-info">
            <div class="member-name member-name--link">${escapeHtml(p.person_name)}</div>
            <div class="member-sub person-role">${escapeHtml(roleLabel(role, profileGenderCache[p.tmdb_person_id])) || 'Cast &amp; Crew'}</div>
        </div>
        <button type="button" class="member-follow-btn${p.following === false ? '' : ' following'}">${p.following === false ? 'FOLLOW' : 'FOLLOWING'}</button>
    </div>`;
}
function wirePersonRows(container, people) {
    container.querySelectorAll('.person-row').forEach((row) => {
        const id = Number(row.dataset.personId);
        const p = people.find((x) => x.tmdb_person_id === id);
        row.querySelector('.member-name').addEventListener('click', () => openPerson(id));
        row.querySelector('.person-avatar').addEventListener('click', () => openPerson(id));
        const btn = row.querySelector('.member-follow-btn');
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                if (p.following === false) { await window.api.followPerson(id, p.person_name, p.profile_path); p.following = true; profileSocial.following += 1; }
                else { await window.api.unfollowPerson(id); p.following = false; profileSocial.following = Math.max(0, profileSocial.following - 1); }
                btn.textContent = p.following === false ? 'FOLLOW' : 'FOLLOWING';
                btn.classList.toggle('following', p.following !== false);
                renderProfileStatsRow('overview');
            } catch (err) { showToast(`Couldn't update follow: ${err.message}`, true); }
            finally { btn.disabled = false; }
        });
    });
}
function studioRowHtml(st) {
    return `
    <div class="member-row studio-row" data-kind="${st.kind}" data-id="${st.tmdb_id}">
        <div class="member-avatar person-avatar studio-avatar">${st.logo_path ? `<img src="${imgSrc(st.logo_path)}" alt="">` : `<span>${escapeHtml((st.name || '?').charAt(0))}</span>`}</div>
        <div class="member-info">
            <div class="member-name member-name--link">${escapeHtml(st.name)}</div>
            <div class="member-sub">${st.kind === 'network' ? 'Network' : 'Studio'}</div>
        </div>
        <button type="button" class="member-follow-btn${st.following === false ? '' : ' following'}">${st.following === false ? 'FOLLOW' : 'FOLLOWING'}</button>
    </div>`;
}
function wireStudioRows(container, studiosList) {
    container.querySelectorAll('.studio-row').forEach((row) => {
        const kind = row.dataset.kind, id = Number(row.dataset.id);
        const st = studiosList.find((x) => x.kind === kind && x.tmdb_id === id);
        if (!st) return;
        row.querySelector('.member-name').addEventListener('click', () => openStudio(kind, id));
        row.querySelector('.person-avatar').addEventListener('click', () => openStudio(kind, id));
        const btn = row.querySelector('.member-follow-btn');
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                if (st.following === false) { await window.api.followStudio(kind, id, st.name, st.logo_path); st.following = true; profileSocial.following += 1; }
                else { await window.api.unfollowStudio(kind, id); st.following = false; profileSocial.following = Math.max(0, profileSocial.following - 1); }
                btn.textContent = st.following === false ? 'FOLLOW' : 'FOLLOWING';
                btn.classList.toggle('following', st.following !== false);
                renderProfileStatsRow('overview');
            } catch (err) { showToast(`Couldn't update follow: ${err.message}`, true); }
            finally { btn.disabled = false; }
        });
    });
}
function loadFollowedRoles(people, onUpdate) {
    const jobs = people.filter((p) => !profileRoleCache[p.tmdb_person_id]).map((p) =>
        window.api.getPerson(p.tmdb_person_id).then((d) => {
            profileGenderCache[p.tmdb_person_id] = d.gender;
            profileRoleCache[p.tmdb_person_id] = d.known_for_department || 'Person';
            onUpdate?.();
        }).catch(() => {}));
    return Promise.all(jobs).then(saveRoleCache);
}

function renderProfileNetworkTab(container) {
    if (profileNetworkTab === 'find') profileNetworkTab = 'following';
    const tabs = [['following', 'Following'], ['followers', 'Followers']];
    container.innerHTML = `
        <div class="network-head">
            <div class="seg" id="networkSeg">${tabs.map(([k, l]) => `<button type="button" data-sub="${k}" class="${profileNetworkTab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
            <div id="networkHeadRight" class="network-head-right"></div>
        </div>
        <div id="profileNetworkBody"></div>`;
    container.querySelectorAll('#networkSeg button').forEach((b) => b.addEventListener('click', () => { profileNetworkTab = b.dataset.sub; renderProfileNetworkTab(container); }));
    const body = document.getElementById('profileNetworkBody');
    const kind = profileNetworkTab;

    if (kind === 'followers') {
        body.innerHTML = '<div id="profileNetworkList" class="member-list"></div>';
        const list = body.querySelector('#profileNetworkList');
        const paint = (members) => {
            list.innerHTML = members.length ? members.map(memberRowHtml).join('') : '<p class="profile-tab-empty">No followers yet.</p>';
            wireMemberRows(list, members);
        };
        if (profileNetCache.followers) { paint(profileNetCache.followers); return; }
        list.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
        window.api.listNetwork('followers').then((m) => {
            profileNetCache.followers = m;
            if (profileActiveTab === 'network' && profileNetworkTab === 'followers' && document.getElementById('profileNetworkList')) paint(m);
        }).catch(() => {});
        return;
    }

    // Following = profiles you follow + cast/crew you follow, with filter pills, sort and list/grid view.
    body.innerHTML = `
        <div id="profileNetworkList" class="member-list"></div>`;
    document.getElementById('networkHeadRight').innerHTML = `
        <div class="seg following-pills">${[['all', 'All'], ['people', 'People'], ['members', 'Members']].map(([k, l]) => `<button type="button" data-f="${k}" class="${profileFollowingFilter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div id="followingSort"></div>
        <button type="button" id="followingViewBtn" class="sort-direction-btn" title="Switch view"></button>`;
    const list = body.querySelector('#profileNetworkList');
    const people = profilePeopleCache;
    let studiosList = profileStudiosCache || [];
    let members = profileNetCache.following || [];
    const paint = () => {
        list.classList.toggle('member-grid', profileFollowingView === 'grid');
        const items = [];
        if (profileFollowingFilter !== 'members') people.forEach((p, i) => items.push({ kind: 'person', p, name: p.person_name, t: p.created_at, i }));
        if (profileFollowingFilter !== 'members') studiosList.forEach((st, i) => items.push({ kind: 'studio', st, name: st.name, t: st.created_at, i }));
        if (profileFollowingFilter !== 'people') members.forEach((m, i) => items.push({ kind: 'member', m, name: m.display_name || '', t: null, i }));
        // Directors first, then writers, then the rest of the crew, then actors, then members.
        const ROLE_ORDER = { Directing: 0, Writing: 1, Production: 2, Acting: 4 };
        const rank = (it) => {
            if (it.kind === 'member') return 5;
            if (it.kind === 'studio') return -1;
            const r = profileRoleCache[it.p.tmdb_person_id];
            return r in ROLE_ORDER ? ROLE_ORDER[r] : 3;
        };
        if (profileFollowingSort === 'alphabetical') items.sort((a, b) => a.name.localeCompare(b.name));
        else if (profileFollowingSort === 'role') items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
        // 'recent' keeps each source's own newest-first order (people first, then members)
        list.innerHTML = items.length ? items.map((it) => it.kind === 'person' ? personRowHtml(it.p) : it.kind === 'studio' ? studioRowHtml(it.st) : memberRowHtml(it.m)).join('')
            : '<p class="profile-tab-empty">Nothing here yet — follow cast & crew from their page, or search for members in the main search bar.</p>';
        wirePersonRows(list, people);
        wireStudioRows(list, studiosList);
        wireMemberRows(list, members);
    };
    // Paint once, fully ordered: wait for roles + members if they aren't prefetched yet.
    const pending = [];
    if (!people.every((p) => profileRoleCache[p.tmdb_person_id])) pending.push(loadFollowedRoles(people));
    if (profileStudiosCache === null) pending.push(window.api.listFollowedStudios().then((x) => { profileStudiosCache = x || []; studiosList = profileStudiosCache; }).catch(() => { profileStudiosCache = []; }));
    if (!profileNetCache.following) pending.push(window.api.listNetwork('following').then((m) => { profileNetCache.following = m; members = m; }));
    if (pending.length) {
        list.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
        Promise.all(pending).then(() => { if (document.getElementById('profileNetworkList') === list) paint(); }).catch(() => paint());
    } else paint();
    document.querySelectorAll('.following-pills button').forEach((b) => b.addEventListener('click', () => {
        profileFollowingFilter = b.dataset.f;
        document.querySelectorAll('.following-pills button').forEach((x) => x.classList.toggle('active', x === b));
        paint();
    }));
    const viewBtn = document.getElementById('followingViewBtn');
    const ICON_LIST = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>';
    const ICON_GRID = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>';
    const paintViewBtn = () => {
        // shows the view you'll switch TO
        viewBtn.innerHTML = profileFollowingView === 'list' ? ICON_GRID : ICON_LIST;
        viewBtn.title = profileFollowingView === 'list' ? 'Switch to grid view' : 'Switch to list view';
    };
    paintViewBtn();
    viewBtn.onclick = () => { profileFollowingView = profileFollowingView === 'list' ? 'grid' : 'list'; paintViewBtn(); paint(); };
    createCustomSelect({
        container: document.getElementById('followingSort'),
        options: [{ value: 'role', label: 'Role' }, { value: 'alphabetical', label: 'Alphabetical' }, { value: 'recent', label: 'Recently Followed' }],
        value: profileFollowingSort,
        onChange: (v) => { profileFollowingSort = v; paint(); },
    });
}

// ---------- Activity tab ----------
let profileActivitySub = 'you';
let profileActivityCache = null; // { version, extras }
let profileActivityShown = 40;
function activityAgo(iso) {
    if (!iso) return '';
    const t = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).getTime();
    if (!Number.isFinite(t)) return '';
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (m < 60) return `${Math.max(1, m)}m`;
    const h = Math.round(m / 60); if (h < 24) return `${h}h`;
    const d = Math.round(h / 24); if (d < 14) return `${d}d`;
    const w = Math.round(d / 7); if (w < 9) return `${w}w`;
    const mo = Math.round(d / 30); if (mo < 12) return `${mo}mo`;
    return `${Math.round(d / 365)}y`;
}
function starsText(r) {
    if (!r) return '';
    const full = Math.floor(r / 2);
    return '★'.repeat(full) + (r % 2 ? '½' : '');
}
function activityAvatar(name, who = {}) {
    if (who.self) {
        return profileAvatarUrl
            ? `<div class="act-avatar"><img src="${profileAvatarUrl}" alt=""></div>`
            : `<div class="act-avatar" style="background:${profileSelectedColor || colorForId(name || 'x')}">${escapeHtml((name || '?').charAt(0).toUpperCase())}</div>`;
    }
    if (who.official) return '<div class="act-avatar" style="background:#111"><img src="assets/official-icon.png" alt=""></div>';
    if (who.url) return `<div class="act-avatar"><img src="${who.url}" alt=""></div>`;
    return `<div class="act-avatar" style="background:${colorForId(who.id || name || 'x')}">${escapeHtml((name || '?').charAt(0).toUpperCase())}</div>`;
}
function activityDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.toLocaleDateString('en-US', { weekday: 'long' })} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
// Compact one-liner (no review), expanded poster card (with review) — same rounded poster look as the rest of the app.
function spoilerHtml(text, spoiler, cls) {
    if (!spoiler) return `<div class="${cls}">${escapeHtml(text)}</div>`;
    return `<div class="spoiler-wrap"><div class="spoiler-warn">Contains spoilers &middot; click to reveal</div><div class="${cls} spoiler-body hidden">${escapeHtml(text)}</div></div>`;
}
document.addEventListener('click', (e) => {
    const w = e.target.closest('.spoiler-wrap');
    if (!w || w.classList.contains('open')) return;
    e.stopPropagation();
    w.classList.add('open');
    w.querySelector('.spoiler-warn')?.classList.add('hidden');
    w.querySelector('.spoiler-body')?.classList.remove('hidden');
}, true);
function filmEventHtml(who, m, rating, review, at, liked, spoiler) {
    const year = (m.release_date || '').slice(0, 4);
    const hasReview = review && review.trim();
    const verb = liked && rating ? 'watched, rated and liked' : liked ? 'watched and liked' : rating ? 'watched and rated' : 'watched';
    const stars = (rating ? ` <span class="act-stars">${starsText(rating)}</span>` : '') + (liked ? ' <span class="act-heart">&#9829;</span>' : '');
    if (!hasReview) {
        return `<div class="act-row" data-tmdb-id="${m.tmdb_id}" data-media-type="${m.media_type}">
            <div class="act-row-text"><b class="act-who">${escapeHtml(who)}</b> ${verb} <a class="act-title-link">${escapeHtml(m.title)}</a>${stars} <span class="act-dim">on ${activityDate(at)}</span></div>
            <span class="act-ago">${activityAgo(at)}</span></div>`;
    }
    return `<div class="act-film" data-tmdb-id="${m.tmdb_id}" data-media-type="${m.media_type}">
        <div class="poster-card act-poster"><div class="poster-img-wrap"><img src="${m.poster_path ? imgSrc(m.poster_path) : (m.poster_url || '')}" alt="${escapeHtml(m.title)}" loading="lazy"></div></div>
        <div class="act-film-body">
            <div class="act-line"><span><b class="act-who">${escapeHtml(who)}</b> ${verb}</span><span class="act-ago">${activityAgo(at)}</span></div>
            <div class="act-film-title">${escapeHtml(m.title)} <span class="act-year">${year}</span></div>
            ${stars ? `<div>${stars}</div>` : ''}
            ${spoilerHtml(review.length > 320 ? review.slice(0, 320) + '…' : review, spoiler, 'act-review')}
        </div>
    </div>`;
}
function whoHtml(name) { return `<b class="act-who">${escapeHtml(name)}</b>`; }
function textEventHtml(who, text, at, avatarWho) {
    return `<div class="act-text">${activityAvatar(who, avatarWho || {})}<div class="act-text-body">${text}</div><span class="act-ago">${activityAgo(at)}</span></div>`;
}
function listEventHtml(who, l, at) {
    const posters = l.preview_posters || [];
    return `<div class="act-list" data-list-id="${l.id}">
        <div class="act-text">${activityAvatar(who, { self: true })}<div class="act-text-body"><b class="act-who">${escapeHtml(who)}</b> listed <b class="act-list-name">${escapeHtml(l.name)}</b> <span class="act-dim">(${l.item_count || 0} ${l.item_count === 1 ? 'film' : 'films'})</span></div><span class="act-ago">${activityAgo(at)}</span></div>
        <div class="act-list-card">
            <div class="list-card-pile">${posters.length ? posters.map((p, i) => `<img class="list-card-pile-poster" src="${imgSrc(p)}" alt="" style="z-index:${posters.length - i};" loading="lazy">`).join('') : '<div class="list-card-pile-empty">No titles yet</div>'}</div>
            ${l.description ? `<div class="act-list-desc">${escapeHtml(l.description)}</div>` : ''}
        </div>
    </div>`;
}
let profileViewingOther = false; // flips on once other members' profiles can be opened
async function renderProfileActivityTab(container) {
    const myName = (profileEls.nameDisplay.textContent || '').trim() || 'You';
    const subs = profileViewingOther ? [['you', myName], ['friends', 'Friends']] : [['you', 'You'], ['family', 'Family'], ['friends', 'Friends'], ['incoming', 'Incoming']];
    if (!subs.some(([k]) => k === profileActivitySub)) profileActivitySub = 'you';
    container.innerHTML = `
        <div class="act-layout">
            <div class="act-main">
                <div class="network-head"><div class="seg" id="activitySeg">
                    ${subs.map(([k, l]) => `<button type="button" data-sub="${k}" class="${profileActivitySub === k ? 'active' : ''}">${escapeHtml(l)}</button>`).join('')}
                </div></div>
                <div id="activityFeed" class="act-feed"><div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div></div>
            </div>
            <aside class="act-side"><div class="act-side-head"><span>FOLLOWING</span><span id="actSideCount">${profileSocial.following}</span></div><div id="actSideGrid" class="act-side-grid"></div></aside>
        </div>`;
    container.querySelectorAll('#activitySeg button').forEach((b) => b.addEventListener('click', () => { profileActivitySub = b.dataset.sub; profileActivityShown = 40; renderProfileActivityTab(container); }));
    if (!profileActivityCache || profileActivityCache.version !== entriesCacheVersion) {
        let extras = { likedLists: [], newFollowers: [], following: [], listLikes: [], friends: [], family: [], officialIds: [] };
        try { extras = await window.api.getActivityExtras(); } catch (err) { console.error(err); }
        profileActivityCache = { version: entriesCacheVersion, extras };
    }
    if (profileActiveTab !== 'activity') return;
    const ex = profileActivityCache.extras;
    const official = new Set(ex.officialIds || []);
    const openOfficial = (el) => el.addEventListener('click', (e) => { e.stopPropagation(); openOfficialAccountPage(); });

    // Sidebar: avatars of everyone you follow
    const paintSide = (members) => {
        const grid = document.getElementById('actSideGrid');
        if (!grid) return;
        const cells = [
            ...members.map((m) => `<div class="act-side-cell${m.is_official ? ' official' : ''}" title="${escapeHtml(m.display_name || '')}" data-official="${m.is_official ? 1 : 0}">${m.is_official ? '<img src="assets/official-icon.png" alt="">' : m.avatar_url ? `<img src="${m.avatar_url}" alt="">` : `<span style="background:${m.avatar_color || colorForId(m.id)}">${escapeHtml((m.display_name || '?').charAt(0).toUpperCase())}</span>`}</div>`),
            ...profilePeopleCache.map((p) => `<div class="act-side-cell" title="${escapeHtml(p.person_name)}" data-person="${p.tmdb_person_id}">${p.profile_path ? `<img src="${imgSrc(p.profile_path)}" alt="">` : `<span style="background:#444">${escapeHtml(p.person_name.charAt(0))}</span>`}</div>`),
            ...(profileStudiosCache || []).map((st) => `<div class="act-side-cell studio-cell" title="${escapeHtml(st.name)}" data-studio-kind="${st.kind}" data-studio-id="${st.tmdb_id}">${st.logo_path ? `<img src="${imgSrc(st.logo_path)}" alt="" style="object-fit:contain;background:#fff;padding:3px">` : `<span style="background:#444">${escapeHtml(st.name.charAt(0))}</span>`}</div>`),
        ];
        grid.innerHTML = cells.join('') || '<p class="profile-tab-empty">Not following anyone yet.</p>';
        grid.querySelectorAll('.act-side-cell[data-studio-id]').forEach((c) => c.addEventListener('click', () => openStudio(c.dataset.studioKind, Number(c.dataset.studioId))));
        grid.querySelectorAll('.act-side-cell[data-official="1"]').forEach(openOfficial);
        grid.querySelectorAll('.act-side-cell[data-person]').forEach((c) => c.addEventListener('click', () => openPerson(Number(c.dataset.person))));
    };
    if (profileNetCache.following) paintSide(profileNetCache.following);
    else window.api.listNetwork('following').then((m) => { profileNetCache.following = m; paintSide(m); }).catch(() => paintSide([]));

    const feed = document.getElementById('activityFeed');
    const events = [];
    const name = myName;
    const self = { self: true };
    const YOU = profileViewingOther ? myName : 'You';
    if (profileActivitySub === 'you') {
        profileAllEntries.filter((e) => profileFinished(e) && e.status !== 'dropped').forEach((e) => {
            const at = e.date_rewatched || e.date_finished || e.updated_at;
            events.push({ at, html: filmEventHtml(YOU, e, e.rating, e.review, at, e.is_favorite, e.review_spoilers) });
        });
        (profileListsCache || []).filter((l) => !l.is_favorites).forEach((l) => events.push({ at: l.created_at, html: listEventHtml(YOU, l, l.created_at) }));
        ex.likedLists.forEach((l) => events.push({ at: l.at, html: textEventHtml(YOU, `${whoHtml(YOU)} liked <b>${escapeHtml(l.owner_name)}</b>’s <a class="act-link" data-list-id="${l.id}">${escapeHtml(l.name)}</a> list`, l.at, self) }));
        ex.following.forEach((f) => events.push({ at: f.at, html: textEventHtml(YOU, `${whoHtml(YOU)} followed ${official.has(f.id) ? '<a class="act-link act-official">Official Lists</a>' : `<b>${escapeHtml(f.name)}</b>`}`, f.at, self) }));
        (profileStudiosCache || []).forEach((st) => events.push({ at: st.created_at, html: textEventHtml(YOU, `${whoHtml(YOU)} followed <a class="act-link" data-studio-kind="${st.kind}" data-studio-id="${st.tmdb_id}">${escapeHtml(st.name)}</a>`, st.created_at, self) }));
        profilePeopleCache.forEach((p) => events.push({ at: p.created_at, html: textEventHtml(YOU, `${whoHtml(YOU)} followed <a class="act-link" data-person-id="${p.tmdb_person_id}">${escapeHtml(p.person_name)}</a>`, p.created_at, self) }));
    } else if (profileActivitySub === 'incoming') {
        ex.newFollowers.forEach((f) => events.push({ at: f.at, html: textEventHtml(f.name, `<b>${escapeHtml(f.name)}</b> started following you`, f.at, { id: f.id, official: official.has(f.id) }) }));
        ex.listLikes.forEach((l) => events.push({ at: l.at, html: textEventHtml(l.user_name, `<b>${escapeHtml(l.user_name)}</b> liked your list <a class="act-link" data-list-id="${l.list_id}">${escapeHtml(l.list_name || '')}</a>`, l.at, { id: l.user_id }) }));
    } else if (profileActivitySub === 'family') {
        (ex.family || []).forEach((f) => events.push({ at: f.at, html: filmEventHtml(f.user_name, f.media, f.rating, f.review, f.at, false, f.review_spoilers) }));
    } else {
        ex.friends.forEach((f) => events.push({ at: f.at, html: filmEventHtml(f.user_name, f.media, f.rating, f.review, f.at, false, f.review_spoilers) }));
    }
    events.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    if (!events.length) {
        feed.innerHTML = `<p class="profile-tab-empty">${profileActivitySub === 'friends' ? 'No recent activity — follow members from the main search to see what they watch.' : profileActivitySub === 'family' ? 'No recent activity from your family.' : 'No recent activity'}</p>`;
        return;
    }
    const shown = events.slice(0, profileActivityShown);
    feed.innerHTML = shown.map((e) => `<div class="act-item">${e.html}</div>`).join('')
        + (events.length > shown.length ? '<button type="button" id="activityMore" class="view-all-btn act-more">Show more</button>' : '<p class="act-end">End of recent activity</p>');
    document.getElementById('activityMore')?.addEventListener('click', () => { profileActivityShown += 40; renderProfileActivityTab(container); });
    feed.querySelectorAll('.act-film, .act-row').forEach((f) => f.addEventListener('click', () => openDetails(Number(f.dataset.tmdbId), f.dataset.mediaType)));
    feed.querySelectorAll('.act-list').forEach((l) => l.addEventListener('click', () => openListFromAnywhere(l.dataset.listId)));
    feed.querySelectorAll('.act-link[data-list-id]').forEach((a) => a.addEventListener('click', () => openListFromAnywhere(a.dataset.listId)));
    feed.querySelectorAll('.act-link[data-studio-id]').forEach((a) => a.addEventListener('click', () => openStudio(a.dataset.studioKind, Number(a.dataset.studioId))));
    feed.querySelectorAll('.act-link[data-person-id]').forEach((a) => a.addEventListener('click', () => openPerson(Number(a.dataset.personId))));
    feed.querySelectorAll('.act-official').forEach(openOfficial);
}

function profileFinished(e) {
    return e.status === 'completed' || e.status === 'rewatched' || e.status === 'dropped';
}

// The banner's stat row shows different numbers depending on which tab is
// active: totals on Overview, Films/Series counts on the films tab, and
// nothing on the tabs that don't have an equivalent summary.
function renderProfileStatsRow(mode, counts = {}) {
    renderProfileStatsRowBase(mode, counts);
    const social = [['Lists', profileSocial.lists, 'lists'], ['Following', profileSocial.following, 'following'], ['Followers', profileSocial.followers, 'followers']];
    profileEls.statsRow.innerHTML += social.map(([l, n, g]) =>
        `<div data-goto="${g}"><div class="profile-stat-num">${n}</div><div class="profile-stat-label">${l}</div></div>`).join('');
}
function renderProfileStatsRowBase(mode, counts = {}) {
    if (mode === 'overview') {
        const watchedCount = profileAllEntries.filter((e) => profileFinished(e) && (e.media_type === 'movie' || e.media_type === 'tv')).length;
        const readCount = profileAllEntries.filter((e) => profileFinished(e) && e.media_type === 'book').length;
        const playedCount = profileAllEntries.filter((e) => profileFinished(e) && e.media_type === 'game').length;
        profileEls.statsRow.innerHTML = `
            <div data-goto="films"><div class="profile-stat-num">${watchedCount}</div><div class="profile-stat-label">Watched</div></div>
            <div data-goto="books"><div class="profile-stat-num">${readCount}</div><div class="profile-stat-label">Read</div></div>
            <div data-goto="games"><div class="profile-stat-num">${playedCount}</div><div class="profile-stat-label">Played</div></div>
        `;
    } else if (mode === 'films') {
        profileEls.statsRow.innerHTML = `
            <div data-goto="films"><div class="profile-stat-num">${counts.movies}</div><div class="profile-stat-label">Films</div></div>
            <div><div class="profile-stat-num">${counts.series}</div><div class="profile-stat-label">Series</div></div>
            <div><div class="profile-stat-num">${counts.shorts}</div><div class="profile-stat-label">Shorts</div></div>
        `;
    } else {
        profileEls.statsRow.innerHTML = '';
    }
}

function renderProfileTab(tab) {
    const container = document.getElementById('profileTabContent');
    // Hold the current height while the new tab paints so the page doesn't collapse and jump to the top.
    container.style.minHeight = `${container.offsetHeight}px`;
    clearTimeout(renderProfileTab._t);
    renderProfileTab._t = setTimeout(() => { container.style.minHeight = ''; }, 800);
    const entries = profileAllEntries;

    if (tab !== 'overview' && tab !== 'films' && tab !== 'books' && tab !== 'games') renderProfileStatsRow(tab);

    if (tab === 'overview') {
        renderProfileStatsRow('overview');
        // Favorites follow the order (and "show on profile" choice) from the Favorite Titles list.
        const favByMedia = Object.fromEntries(entries.filter((e) => e.is_favorite).map((e) => [e.media_id, e]));
        const orderedFavs = profileFavOrder.items.filter((it) => favByMedia[it.media_id]);
        const placed = new Set(orderedFavs.map((it) => it.media_id));
        const unplaced = Object.keys(favByMedia).map(Number).filter((id) => !placed.has(id)).map((id) => ({ media_id: id, show_on_profile: true }));
        const allFavOrder = [...orderedFavs, ...unplaced];
        const favorites = allFavOrder.filter((it) => it.show_on_profile !== false).map((it) => favByMedia[it.media_id]);
        const hiddenFavIds = allFavOrder.filter((it) => it.show_on_profile === false).map((it) => it.media_id);
        // Sorted by when it was actually watched/read/played (see
        // watchActivityKey), not updated_at — otherwise editing an old
        // entry's rating today would make it jump to the top as if it had
        // just been watched today.
        const recent = [...entries].sort((a, b) => watchActivityKey(b) - watchActivityKey(a)).slice(0, 12);
        container.innerHTML = `
            ${favorites.length ? `
                <div class="profile-tab-section">
                    <div class="poster-row-header profile-fav-header">
                        <h3>Favorite Titles</h3>
                        ${profileFavOrder.listId ? '<button type="button" id="profileFavEditBtn" class="view-all-btn" title="Choose and reorder your favorites">Edit</button>' : ''}
                    </div>
                    <div class="poster-row" id="profileFavoritesRow"></div>
                </div>
            ` : ''}
            <div class="profile-tab-section">
                <h3>Recent Activity</h3>
                <div class="poster-row" id="profileRecentRow"></div>
            </div>
        `;
        if (favorites.length) {
            const favRow = document.getElementById('profileFavoritesRow');
            renderPosterGrid(favRow, favorites, 'last_watched');
            wireSortablePosters(favRow, favorites, async (newOrder) => {
                // Save the visible order first, hidden favorites keep their place after them.
                const ids = [...newOrder.map((e) => e.media_id), ...hiddenFavIds];
                try { await window.api.reorderListItems(profileFavOrder.listId, ids); }
                catch (err) { showToast(`Couldn't save the new order: ${err.message}`, true); }
                profileFavOrder.items = ids.map((id, i) => ({ media_id: id, position: i + 1, show_on_profile: !hiddenFavIds.includes(id) }));
            });
        }
        document.getElementById('profileFavEditBtn')?.addEventListener('click', () => openListFromAnywhere(profileFavOrder.listId));
        renderPosterGrid(document.getElementById('profileRecentRow'), recent, 'last_watched');
        return;
    }

    if (tab === 'films') {
        // Shorts get their own section rather than padding out the features
        // list — same 40-minute cut-off the dashboard's short films row uses.
        const allMovies = entries.filter((e) => profileFinished(e) && e.media_type === 'movie');
        const movies = allMovies.filter((e) => !isShortFilm(e));
        const shorts = allMovies.filter(isShortFilm);
        const series = entries.filter((e) => profileFinished(e) && e.media_type === 'tv');
        renderProfileStatsRow('films', { movies: movies.length, series: series.length, shorts: shorts.length });
        const movieSortOptions = [
            { value: 'last_watched', label: 'Last Watched' },
            { value: 'alphabetical', label: 'Alphabetical' },
            { value: 'release_date', label: 'Release Date' },
            { value: 'rating', label: 'My Rating' },
            { value: 'platform_rating', label: 'Platform Rating' },
            { value: 'runtime', label: 'Film Length' },
        ];
        // Every section always renders — an empty one shows its own "nothing
        // yet" message instead of disappearing, same as the other profile tabs.
        const sections = [
            {
                prefix: 'profileFilms', label: 'Films', items: movies, filterState: profileFilmsFilter,
                sortOptions: movieSortOptions,
            },
            {
                prefix: 'profileSeries', label: 'Series', items: series, filterState: profileSeriesFilter,
                sortOptions: [
                    { value: 'last_watched', label: 'Last Watched' },
                    { value: 'alphabetical', label: 'Alphabetical' },
                    { value: 'release_date', label: 'Release Date' },
                    { value: 'rating', label: 'My Rating' },
                    { value: 'platform_rating', label: 'Platform Rating' },
                    { value: 'seasons', label: 'Seasons' },
                ],
            },
            {
                prefix: 'profileShorts', label: 'Short Films', items: shorts, filterState: profileShortsFilter,
                sortOptions: movieSortOptions,
            },
        ];
        container.innerHTML = sections.map((s) => `
            <div class="profile-tab-section">${profileMediaSectionMarkup(s.prefix)}</div>
        `).join('');
        sections.forEach(setupProfileMediaSection);
        return;
    }

    if (tab === 'books' || tab === 'games') {
        const isBook = tab === 'books';
        const items = entries.filter((e) => profileFinished(e) && e.media_type === (isBook ? 'book' : 'game'));
        profileEls.statsRow.innerHTML = `<div><div class="profile-stat-num">${items.length}</div><div class="profile-stat-label">${isBook ? 'Books' : 'Games'}</div></div>`;
        profileEls.statsRow.innerHTML += [['Lists', profileSocial.lists, 'lists'], ['Following', profileSocial.following, 'following'], ['Followers', profileSocial.followers, 'followers']]
            .map(([l, n, g]) => `<div data-goto="${g}"><div class="profile-stat-num">${n}</div><div class="profile-stat-label">${l}</div></div>`).join('');
        const sec = {
            prefix: isBook ? 'profileBooks' : 'profileGames', label: isBook ? 'Books' : 'Games', items,
            filterState: isBook ? profileBooksFilter : profileGamesFilter,
            emptyText: isBook ? 'No books read yet.' : 'No games played yet.',
            sortOptions: [
                { value: 'last_watched', label: isBook ? 'Last Read' : 'Last Played' },
                { value: 'alphabetical', label: 'Alphabetical' },
                { value: 'release_date', label: 'Release Date' },
                { value: 'rating', label: 'My Rating' },
            ],
        };
        container.innerHTML = `<div class="profile-tab-section">${profileMediaSectionMarkup(sec.prefix)}</div>`;
        setupProfileMediaSection(sec);
        return;
    }

    if (tab === 'activity') { renderProfileActivityTab(container); return; }
    if (tab === 'lists') { renderProfileListsTab(container); return; }
    if (tab === 'likes') { renderProfileLikesTab(container); return; }
    if (tab === 'network') { renderProfileNetworkTab(container); return; }

    if (tab === 'diary') {
        const dated = entries.filter((e) => e.date_finished || e.date_rewatched);
        container.innerHTML = `
            <div class="poster-row-header">
                <h3>Add to your diary</h3>
                <div class="poster-row-header-controls">
                    <div class="library-search-wrap profile-filter-search">
                        <svg class="library-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                        <input type="text" id="profileDiarySearch" class="library-search-input" placeholder="Search diary…">
                    </div>
                    <div id="profileDiaryRating"></div>
                    <div id="profileDiaryYear"></div>
                    <div id="profileDiaryDecade"></div>
                    <div id="profileDiaryGenre"></div>
                    <div class="sort-control-group">
                        <div id="profileDiarySort"></div>
                        <button type="button" id="profileDiarySortDir" class="sort-direction-btn" title="Descending (click for ascending)">
                            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 4v16M12 20l-5-5M12 20l5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                    </div>
                </div>
            </div>
            <div id="profileDiaryTableWrap"></div>
        `;
        // Each ticked episode is its own diary row (see episode-diary-migration.sql).
        const wrapEl = document.getElementById('profileDiaryTableWrap');
        const build = (epLogs) => {
            const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
            const epRows = (epLogs || []).filter((l) => l.watched_on && byId[l.entry_id]).map((l) => ({
                ...byId[l.entry_id], date_finished: l.watched_on, date_rewatched: null, status: 'completed',
                ep_label: l.episode_label || 'Episode', is_episode: true, rating: null, is_favorite: false, review: '',
            }));
            const all = [...dated, ...epRows];
            if (!all.length) { wrapEl.innerHTML = `<p class="profile-tab-empty">No dated entries yet.</p>`; return; }
            setupProfileDiary(all);
        };
        wrapEl.innerHTML = '<p class="profile-tab-empty">Loading…</p>';
        window.api.listEpisodeLogs().catch(() => []).then((logs) => {
            if (profileActiveTab !== 'diary' || !document.getElementById('profileDiaryTableWrap')) return;
            build(logs);
        });
        return;
    }

    if (tab === 'reviews') {
        const reviewed = entries.filter((e) => e.review && e.review.trim());
        container.innerHTML = `
            <div class="poster-row-header">
                <h3>Reviews</h3>
                <div class="poster-row-header-controls">
                    <div id="profileReviewsRating"></div>
                    <div id="profileReviewsYear"></div>
                    <div class="sort-control-group">
                        <div id="profileReviewsSort"></div>
                        <button type="button" id="profileReviewsSortDir" class="sort-direction-btn" title="Descending (click for ascending)">
                            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 4v16M12 20l-5-5M12 20l5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                    </div>
                </div>
            </div>
            <div id="profileReviewsListWrap"></div>
        `;
        if (!reviewed.length) {
            document.getElementById('profileReviewsListWrap').innerHTML = `<p class="profile-tab-empty">No reviews written yet.</p>`;
            return;
        }
        setupProfileReviews(reviewed);
        return;
    }

    if (tab === 'stats') {
        renderProfileStats(container, entries);
        return;
    }
}

let profileDiaryFilter = { search: '', rating: '', year: '', decade: null, genre: null, sort: 'watched_date', ascending: false };

// Wires up the Diary tab's filter row (search/rating/year/decade/genre/
// sort) — same live-filter pattern as setupProfileMediaSection, just with
// its own filter shape and a grouped table instead of a poster grid.
function setupProfileDiary(items) {
    const wrap = document.getElementById('profileDiaryTableWrap');
    const allGenres = [...new Set(items.flatMap((e) => { try { return JSON.parse(e.genres || '[]'); } catch { return []; } }))].sort();
    const years = [...new Set(items.map((e) => (e.date_rewatched || e.date_finished || '').slice(0, 4)).filter(Boolean))].sort().reverse();

    const refresh = () => {
        let filtered = items;
        if (profileDiaryFilter.search) {
            const q = profileDiaryFilter.search.toLowerCase();
            filtered = filtered.filter((e) => (e.title || '').toLowerCase().includes(q));
        }
        if (profileDiaryFilter.rating === 'none') {
            filtered = filtered.filter((e) => !e.rating);
        } else if (profileDiaryFilter.rating) {
            const [lo, hi] = profileDiaryFilter.rating.split('-').map(Number);
            filtered = filtered.filter((e) => e.rating != null && e.rating >= lo && e.rating <= hi);
        }
        if (profileDiaryFilter.year) filtered = filtered.filter((e) => (e.date_rewatched || e.date_finished || '').startsWith(profileDiaryFilter.year));
        if (profileDiaryFilter.decade != null) filtered = filtered.filter((e) => decadeOf(e.release_date) === profileDiaryFilter.decade);
        if (profileDiaryFilter.genre) {
            filtered = filtered.filter((e) => { try { return JSON.parse(e.genres || '[]').includes(profileDiaryFilter.genre); } catch { return false; } });
        }

        const sorted = [...filtered];
        switch (profileDiaryFilter.sort) {
            case 'release_date': sorted.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '')); break;
            case 'rating': sorted.sort((a, b) => (a.rating ?? -1) - (b.rating ?? -1)); break;
            case 'alphabetical': sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
            case 'watched_date':
            default: sorted.sort((a, b) => watchActivityKey(a) - watchActivityKey(b)); break;
        }
        if (!profileDiaryFilter.ascending) sorted.reverse();

        // The month-calendar badge only makes sense while rows are actually
        // in chronological order — sorting by rating/title/release date
        // would make consecutive rows land in unrelated months.
        wrap.innerHTML = diaryTableHtml(sorted, profileDiaryFilter.sort === 'watched_date');
        wireDiaryTable(wrap);
    };

    const searchInput = document.getElementById('profileDiarySearch');
    searchInput.value = profileDiaryFilter.search || '';
    searchInput.addEventListener('input', (e) => { profileDiaryFilter.search = e.target.value.trim(); refresh(); });

    createCustomSelect({
        container: document.getElementById('profileDiaryRating'),
        options: [
            { value: '', label: 'Any Rating' },
            { value: 'none', label: 'No Rating' },
            { value: '9-10', label: '★★★★★' },
            { value: '7-8', label: '★★★★' },
            { value: '5-6', label: '★★★' },
            { value: '3-4', label: '★★' },
            { value: '1-2', label: '★' },
        ],
        value: profileDiaryFilter.rating,
        onChange: (v) => { profileDiaryFilter.rating = v; refresh(); },
    });
    createCustomSelect({
        container: document.getElementById('profileDiaryYear'),
        options: [{ value: '', label: 'Any Year' }, ...years.map((y) => ({ value: y, label: y }))],
        value: profileDiaryFilter.year,
        onChange: (v) => { profileDiaryFilter.year = v; refresh(); },
    });
    createCustomSelect({
        container: document.getElementById('profileDiaryDecade'),
        options: [{ value: '', label: 'Any Decade' }, ...Array.from({ length: 14 }, (_, i) => {
            const d = 2020 - i * 10;
            return { value: String(d), label: `${d}s` };
        })],
        value: profileDiaryFilter.decade != null ? String(profileDiaryFilter.decade) : '',
        onChange: (v) => { profileDiaryFilter.decade = v ? Number(v) : null; refresh(); },
    });
    createCustomSelect({
        container: document.getElementById('profileDiaryGenre'),
        options: [{ value: '', label: 'Any Genre' }, ...allGenres.map((g) => ({ value: g, label: g }))],
        value: profileDiaryFilter.genre || '',
        onChange: (v) => { profileDiaryFilter.genre = v || null; refresh(); },
    });
    createCustomSelect({
        container: document.getElementById('profileDiarySort'),
        options: [
            { value: 'watched_date', label: 'Sort by Watched Date' },
            { value: 'release_date', label: 'Release Date' },
            { value: 'rating', label: 'Rating' },
            { value: 'alphabetical', label: 'Alphabetical' },
        ],
        value: profileDiaryFilter.sort,
        onChange: (v) => { profileDiaryFilter.sort = v; refresh(); },
    });
    const dirBtn = document.getElementById('profileDiarySortDir');
    dirBtn.classList.toggle('ascending', profileDiaryFilter.ascending);
    dirBtn.onclick = () => {
        profileDiaryFilter.ascending = !profileDiaryFilter.ascending;
        dirBtn.classList.toggle('ascending', profileDiaryFilter.ascending);
        refresh();
    };
    refresh();
}

// Renders the actual Letterboxd-style diary table: a calendar-badge cell
// that only shows on the first row of each new month (blank underneath, so
// it reads as one badge "for" the whole month's block of rows), then day/
// film/released/rating/rewatch/review/favorite columns.
function diaryTableHtml(items, groupByMonth) {
    if (!items.length) return `<p class="profile-tab-empty">No dated entries match these filters.</p>`;
    let lastMonthKey = null;
    const rows = items.map((e) => {
        const dateStr = e.date_rewatched || e.date_finished;
        const d = dateStr ? new Date(`${dateStr}T00:00:00`) : null;
        const monthKey = d ? `${d.getFullYear()}-${d.getMonth()}` : null;
        const isNewMonth = !groupByMonth || monthKey !== lastMonthKey;
        lastMonthKey = monthKey;

        const posterUrl = e.poster_url || (e.poster_path ? `${imgSrc(e.poster_path)}` : '');
        // A favorite outranks a star rating rather than sitting alongside it
        // — same "beyond the 5-star scale" logic used for sorting by rating
        // elsewhere, just shown as the heart instead of stars here.
        const ratingDisplay = (e.rating ? `${'★'.repeat(Math.floor(e.rating / 2))}${e.rating % 2 ? '½' : ''}` : '')
            + (e.is_favorite ? ' <span class="diary-heart">&#9829;</span>' : '');

        return `
            <tr class="diary-table-row" data-tmdb-id="${e.tmdb_id}" data-media-type="${e.media_type}" data-media-id="${e.media_id}">
                <td class="diary-month-cell">${isNewMonth && d ? `
                    <div class="diary-month-badge">
                        <span class="diary-month-badge-month">${d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</span>
                        <span class="diary-month-badge-year">${d.getFullYear()}</span>
                    </div>
                ` : ''}</td>
                <td class="diary-day-cell">${d ? d.getDate() : ''}</td>
                <td class="diary-film-cell">
                    <img src="${posterUrl}" alt="" loading="lazy">
                    <span class="diary-film-title">${escapeHtml(e.title)}${e.ep_label ? ` <span class="diary-ep-label">${escapeHtml(e.ep_label)}</span>` : ''}</span>
                </td>
                <td class="diary-released-cell">${(e.release_date || '').slice(0, 4)}</td>
                <td class="diary-rating-cell">${ratingDisplay}</td>
                <td class="diary-rewatch-cell" title="${e.status === 'rewatched' ? 'Rewatch' : ''}">${e.status === 'rewatched' ? '&#8635;' : ''}</td>
                <td class="diary-review-cell" title="${e.review && e.review.trim() ? 'Has a review' : ''}">${e.review && e.review.trim() ? '&#9776;' : ''}</td>
            </tr>
        `;
    }).join('');
    return `<table class="diary-table"><tbody>${rows}</tbody></table>`;
}

// Clicking a row opens the title's detail page, same as the old flat
// diary-row list did — favoriting now happens from there (or the rating
// cell's heart just reflects it), not from a separate button in the table.
function wireDiaryTable(container) {
    container.querySelectorAll('.diary-table-row').forEach((row) => {
        row.addEventListener('click', () => openDetails(Number(row.dataset.tmdbId), row.dataset.mediaType));
    });
}

let profileReviewsFilter = { rating: '', year: '', sort: 'when_reviewed', ascending: false };

// Same live-filter pattern as setupProfileDiary, just for the Reviews tab —
// "When Reviewed" reuses watchActivityKey (the actual watched date), not
// updated_at, so editing an old review's text doesn't bump it to the top.
function setupProfileReviews(items) {
    const wrap = document.getElementById('profileReviewsListWrap');
    const years = [...new Set(items.map((e) => (e.date_rewatched || e.date_finished || e.date_started || '').slice(0, 4)).filter(Boolean))].sort().reverse();

    const refresh = () => {
        let filtered = items;
        if (profileReviewsFilter.rating === 'none') {
            filtered = filtered.filter((e) => !e.rating);
        } else if (profileReviewsFilter.rating) {
            const [lo, hi] = profileReviewsFilter.rating.split('-').map(Number);
            filtered = filtered.filter((e) => e.rating != null && e.rating >= lo && e.rating <= hi);
        }
        if (profileReviewsFilter.year) {
            filtered = filtered.filter((e) => (e.date_rewatched || e.date_finished || e.date_started || '').startsWith(profileReviewsFilter.year));
        }

        const sorted = [...filtered];
        switch (profileReviewsFilter.sort) {
            case 'release_date': sorted.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '')); break;
            case 'rating': sorted.sort((a, b) => (a.rating ?? -1) - (b.rating ?? -1)); break;
            case 'alphabetical': sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
            case 'when_reviewed':
            default: sorted.sort((a, b) => watchActivityKey(a) - watchActivityKey(b)); break;
        }
        if (!profileReviewsFilter.ascending) sorted.reverse();

        wrap.innerHTML = sorted.map((e) => reviewRowHtml(e)).join('');
        wireProfileRows(wrap);
    };

    createCustomSelect({
        container: document.getElementById('profileReviewsRating'),
        options: [
            { value: '', label: 'Any Rating' },
            { value: 'none', label: 'No Rating' },
            { value: '9-10', label: '★★★★★' },
            { value: '7-8', label: '★★★★' },
            { value: '5-6', label: '★★★' },
            { value: '3-4', label: '★★' },
            { value: '1-2', label: '★' },
        ],
        value: profileReviewsFilter.rating,
        onChange: (v) => { profileReviewsFilter.rating = v; refresh(); },
    });
    createCustomSelect({
        container: document.getElementById('profileReviewsYear'),
        options: [{ value: '', label: 'Any Year' }, ...years.map((y) => ({ value: y, label: y }))],
        value: profileReviewsFilter.year,
        onChange: (v) => { profileReviewsFilter.year = v; refresh(); },
    });
    createCustomSelect({
        container: document.getElementById('profileReviewsSort'),
        options: [
            { value: 'when_reviewed', label: 'Sort by When Reviewed' },
            { value: 'release_date', label: 'Release Date' },
            { value: 'rating', label: 'Rating' },
            { value: 'alphabetical', label: 'Alphabetical' },
        ],
        value: profileReviewsFilter.sort,
        onChange: (v) => { profileReviewsFilter.sort = v; refresh(); },
    });
    const dirBtn = document.getElementById('profileReviewsSortDir');
    dirBtn.classList.toggle('ascending', profileReviewsFilter.ascending);
    dirBtn.onclick = () => {
        profileReviewsFilter.ascending = !profileReviewsFilter.ascending;
        dirBtn.classList.toggle('ascending', profileReviewsFilter.ascending);
        refresh();
    };
    refresh();
}

function reviewRowHtml(e) {
    const posterUrl = e.poster_url || (e.poster_path ? `${imgSrc(e.poster_path)}` : '');
    const date = e.date_rewatched || e.date_finished || e.date_started;
    return `
        <div class="review-row" data-tmdb-id="${e.tmdb_id}" data-media-type="${e.media_type}">
            <img class="review-row-poster" src="${posterUrl}" alt="" loading="lazy">
            <div class="review-row-info">
                <div class="review-row-title">${escapeHtml(e.title)} <span style="color:var(--gray);font-weight:400;">${(e.release_date || '').slice(0, 4)}</span></div>
                ${date ? `<div class="diary-row-meta">${formatFullDate(date)}</div>` : ''}
                ${e.rating ? `<div class="review-row-rating">${'★'.repeat(Math.round(e.rating / 2))}${e.rating % 2 ? '½' : ''}</div>` : ''}
                ${spoilerHtml(e.review, e.review_spoilers, 'review-row-text')}
            </div>
        </div>
    `;
}

function wireProfileRows(container) {
    container.querySelectorAll('.review-row').forEach((row) => {
        row.addEventListener('click', () => openDetails(Number(row.dataset.tmdbId), row.dataset.mediaType));
    });
}

function paintProfileAvatar(name) {
    if (profileAvatarUrl) {
        profileEls.avatarLarge.style.background = 'transparent';
        profileEls.avatarLarge.innerHTML = `<img src="${profileAvatarUrl}" alt="">`;
        profileEls.removePhotoBtn.classList.remove('hidden');
    } else {
        profileEls.avatarLarge.style.background = profileSelectedColor;
        profileEls.avatarLarge.textContent = (name || '?').charAt(0).toUpperCase();
        profileEls.removePhotoBtn.classList.add('hidden');
    }
}

function paintProfileBanner() {
    if (profileBannerUrl) {
        profileEls.bannerImg.src = profileBannerUrl;
        profileEls.bannerImg.style.display = 'block';
    } else {
        profileEls.bannerImg.style.display = 'none';
        profileEls.bannerImg.removeAttribute('src');
    }
}

profileEls.nameInput.addEventListener('input', () => paintProfileAvatar(profileEls.nameInput.value));

profileEls.bannerUploadBtn.addEventListener('click', () => profileEls.bannerFileInput.click());

profileEls.bannerFileInput.addEventListener('change', async () => {
    const file = profileEls.bannerFileInput.files[0];
    profileEls.bannerFileInput.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        showToast('Image is too large — 5MB max', true);
        return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
        const base64Data = reader.result.split(',')[1];
        profileEls.bannerUploadBtn.disabled = true;
        try {
            const url = await window.api.uploadAvatar(`banner-${file.name}`, base64Data, file.type);
            profileBannerUrl = url;
            paintProfileBanner();
            await window.api.updateProfile({
                display_name: profileEls.nameInput.value.trim() || null,
                avatar_color: profileSelectedColor,
                avatar_url: profileAvatarUrl,
                banner_url: url,
                bio: profileEls.bioInput.value.trim() || null,
            });
            showToast('Banner updated');
        } catch (err) {
            showToast(`Couldn't upload banner: ${err.message}`, true);
        } finally {
            profileEls.bannerUploadBtn.disabled = false;
        }
    };
    reader.readAsDataURL(file);
});

profileEls.avatarUploadBtn.addEventListener('click', () => profileEls.avatarFileInput.click());

profileEls.avatarFileInput.addEventListener('change', async () => {
    const file = profileEls.avatarFileInput.files[0];
    profileEls.avatarFileInput.value = '';
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
        showToast('Image is too large — 3MB max', true);
        return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
        const base64Data = reader.result.split(',')[1];
        profileEls.avatarUploadBtn.disabled = true;
        try {
            const url = await window.api.uploadAvatar(file.name, base64Data, file.type);
            profileAvatarUrl = url;
            paintProfileAvatar(profileEls.nameInput.value);
            await window.api.updateProfile({
                display_name: profileEls.nameInput.value.trim() || null,
                avatar_color: profileSelectedColor,
                avatar_url: url,
                bio: profileEls.bioInput.value.trim() || null,
            });
            await refreshAccountAvatar();
            showToast('Photo updated');
        } catch (err) {
            showToast(`Couldn't upload photo: ${err.message}`, true);
        } finally {
            profileEls.avatarUploadBtn.disabled = false;
        }
    };
    reader.readAsDataURL(file);
});

profileEls.removePhotoBtn.addEventListener('click', async () => {
    profileAvatarUrl = null;
    paintProfileAvatar(profileEls.nameInput.value);
    try {
        await window.api.updateProfile({
            display_name: profileEls.nameInput.value.trim() || null,
            avatar_color: profileSelectedColor,
            avatar_url: null,
            bio: profileEls.bioInput.value.trim() || null,
            location: document.getElementById('profileLocationInput').value.trim() || null,
            x_handle: document.getElementById('profileXInput').value.trim().replace(/^@/, '') || null,
        });
        paintProfileMeta(document.getElementById('profileLocationInput').value.trim(), document.getElementById('profileXInput').value.trim());
        await refreshAccountAvatar();
    } catch (err) {
        showToast(`Couldn't remove photo: ${err.message}`, true);
    }
});

profileEls.saveBtn.addEventListener('click', async () => {
    profileEls.saveBtn.disabled = true;
    try {
        await window.api.updateProfile({
            display_name: profileEls.nameInput.value.trim() || null,
            avatar_color: profileSelectedColor,
            avatar_url: profileAvatarUrl,
            bio: profileEls.bioInput.value.trim() || null,
        });
        profileStale = true;
        await refreshAccountAvatar();
        // Reflect the saved values in view mode, then drop back to it.
        profileEls.nameDisplay.textContent = profileEls.nameInput.value.trim() || profileEls.nameDisplay.textContent;
        profileEls.bioDisplay.textContent = profileEls.bioInput.value.trim();
        setProfileEditMode(false);
        showToast('Profile saved');
    } catch (err) {
        showToast(`Couldn't save profile: ${err.message}`, true);
    } finally {
        profileEls.saveBtn.disabled = false;
    }
});

profileEls.editBtn.addEventListener('click', () => setProfileEditMode(true));
profileEls.editCancelBtn.addEventListener('click', () => {
    // Discard unsaved edits by reloading the page's data from scratch —
    // simpler and safer than trying to rewind each field individually.
    openProfilePage({ recordHistory: false });
});

profileEls.backBtn.addEventListener('click', goBack);

// Global account menu — same idea as Steam's/Letterboxd's avatar dropdown:
// quick account actions from any page, instead of only from inside the
// full profile page.
authEls.accountAvatarBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = authEls.accountDropdown.classList.contains('hidden');
    authEls.accountDropdown.classList.toggle('hidden', !opening);
    authEls.accountMenu.classList.toggle('open', opening);
    if (opening) refreshSwitchProfileVisibility();
});
document.addEventListener('click', (e) => {
    if (!authEls.accountMenu.contains(e.target)) {
        authEls.accountDropdown.classList.add('hidden');
        authEls.accountMenu.classList.remove('open');
    }
});
function closeAccountDropdown() {
    authEls.accountDropdown.classList.add('hidden');
    authEls.accountMenu.classList.remove('open');
}
authEls.accountDropdownProfile.addEventListener('click', () => {
    closeAccountDropdown();
    openProfilePage();
});
authEls.accountDropdownAccount.addEventListener('click', () => {
    closeAccountDropdown();
    openAccountPage();
});

// "Switch Profile" is only meaningful once there's more than just you in a
// real family — see schema.sql's family tables. Kept separate from
// loadFamilySection so opening the menu doesn't pull the whole roster.
async function refreshSwitchProfileVisibility() {
    try {
        const mine = await window.api.listMyFamily();
        authEls.switchProfileBtn.classList.toggle('hidden', mine.members.length <= 1);
    } catch {
        authEls.switchProfileBtn.classList.add('hidden');
    }
}

async function loadFamilySection() {
    const [session, mine, invitesForMe] = await Promise.all([
        window.api.getSession(),
        window.api.listMyFamily(),
        window.api.listInvitesForMe(),
    ]);
    const myId = session.user.id;
    currentFamilyId = mine.family?.id || null;

    // Nothing to switch to until there's actually more than just yourself
    // in a real family — see supabase/schema.sql's family tables.
    profileEls.switchBtn.classList.toggle('hidden', mine.members.length <= 1);

    // Invites waiting for MY response — shown first, above everything else,
    // regardless of whether I already have a family of my own (I don't,
    // normally, since accepting one puts you in exactly one).
    familyEls.invitesForMe.innerHTML = invitesForMe.length === 0 ? '' : `
        <div class="family-invite-banner">
            ${invitesForMe.map((inv) => `
                <div class="family-invite-banner-row">
                    <span>You've been invited to join a family</span>
                    <div>
                        <button type="button" class="save-btn" data-accept-invite="${inv.id}">Accept</button>
                        <button type="button" class="switch-profile-btn" data-decline-invite="${inv.id}">Decline</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
    familyEls.invitesForMe.querySelectorAll('[data-accept-invite]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await window.api.acceptFamilyInvite(Number(btn.dataset.acceptInvite));
                showToast('Joined the family');
                loadFamilySection();
            } catch (err) {
                showToast(`Couldn't accept: ${err.message}`, true);
                btn.disabled = false;
            }
        });
    });
    familyEls.invitesForMe.querySelectorAll('[data-decline-invite]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            await window.api.declineFamilyInvite(Number(btn.dataset.declineInvite));
            loadFamilySection();
        });
    });

    // No family yet — Steam-style setup choice instead of jumping straight
    // to an invite box (creating one used to happen implicitly on first
    // invite, which is confusing since nothing asked you to name it first).
    familyEls.setup.classList.toggle('hidden', !!mine.family);
    familyEls.manage.classList.toggle('hidden', !mine.family);
    if (!mine.family) return;

    familyEls.nameDisplay.textContent = mine.family.name || 'My Family';

    // Current members.
    familyEls.membersList.innerHTML = mine.members.map((m) => `
        <div class="family-member-row">
            <span>${escapeHtml(m.email)}${m.user_id === myId ? ' (you)' : ''}</span>
            ${m.user_id !== myId ? `<button type="button" class="picker-remove-btn family-remove-btn" data-remove-member="${m.user_id}" title="Remove">&#10005;</button>` : ''}
        </div>
    `).join('');
    familyEls.membersList.querySelectorAll('[data-remove-member]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await window.api.removeFamilyMember(btn.dataset.removeMember);
                loadFamilySection();
            } catch (err) {
                showToast(`Couldn't remove: ${err.message}`, true);
            }
        });
    });

    // Invites I've sent that are still awaiting a response.
    familyEls.sentInvites.innerHTML = mine.sentInvites.length === 0 ? '' : `
        <p class="family-section-subheading">Pending invites</p>
        ${mine.sentInvites.map((inv) => `
            <div class="family-member-row">
                <span>${escapeHtml(inv.invited_email)} — pending</span>
                <button type="button" class="picker-remove-btn family-remove-btn" data-revoke-invite="${inv.id}" title="Revoke">&#10005;</button>
            </div>
        `).join('')}
    `;
    familyEls.sentInvites.querySelectorAll('[data-revoke-invite]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            await window.api.revokeFamilyInvite(Number(btn.dataset.revokeInvite));
            loadFamilySection();
        });
    });
}

let currentFamilyId = null;

familyEls.inviteBtn.addEventListener('click', async () => {
    const email = familyEls.inviteEmail.value.trim();
    if (!email) return;
    familyEls.inviteBtn.disabled = true;
    try {
        await window.api.inviteToFamily(email);
        familyEls.inviteEmail.value = '';
        showToast('Invite sent');
        loadFamilySection();
    } catch (err) {
        showToast(`Couldn't send invite: ${err.message}`, true);
    } finally {
        familyEls.inviteBtn.disabled = false;
    }
});

// ---- family setup (Create a Family / Join a Family) ----
familyEls.setupCreateBtn.addEventListener('click', () => {
    familyEls.joinInfo.classList.add('hidden');
    familyEls.createForm.classList.toggle('hidden');
    if (!familyEls.createForm.classList.contains('hidden')) familyEls.nameInput.focus();
});
familyEls.setupJoinBtn.addEventListener('click', () => {
    familyEls.createForm.classList.add('hidden');
    familyEls.joinInfo.classList.toggle('hidden');
});
familyEls.createCancelBtn.addEventListener('click', () => {
    familyEls.createForm.classList.add('hidden');
    familyEls.nameInput.value = '';
});
familyEls.createConfirmBtn.addEventListener('click', async () => {
    const name = familyEls.nameInput.value.trim();
    if (!name) {
        showToast('Give your family a name', true);
        return;
    }
    familyEls.createConfirmBtn.disabled = true;
    try {
        await window.api.createFamily(name);
        familyEls.nameInput.value = '';
        familyEls.createForm.classList.add('hidden');
        showToast('Family created');
        loadFamilySection();
    } catch (err) {
        showToast(`Couldn't create family: ${err.message}`, true);
    } finally {
        familyEls.createConfirmBtn.disabled = false;
    }
});

// ---- family rename (the pencil next to "Your family: <name>") ----
familyEls.nameEditBtn.addEventListener('click', () => {
    familyEls.nameEditInput.value = familyEls.nameDisplay.textContent;
    familyEls.nameDisplay.classList.add('hidden');
    familyEls.nameEditBtn.classList.add('hidden');
    familyEls.nameEditInput.classList.remove('hidden');
    familyEls.nameSaveBtn.classList.remove('hidden');
    familyEls.nameEditInput.focus();
});
familyEls.nameSaveBtn.addEventListener('click', async () => {
    const name = familyEls.nameEditInput.value.trim();
    if (!name || !currentFamilyId) return;
    familyEls.nameSaveBtn.disabled = true;
    try {
        await window.api.renameFamily(currentFamilyId, name);
        familyEls.nameDisplay.textContent = name;
        showToast('Family renamed');
    } catch (err) {
        showToast(`Couldn't rename: ${err.message}`, true);
    } finally {
        familyEls.nameDisplay.classList.remove('hidden');
        familyEls.nameEditBtn.classList.remove('hidden');
        familyEls.nameEditInput.classList.add('hidden');
        familyEls.nameSaveBtn.classList.add('hidden');
        familyEls.nameSaveBtn.disabled = false;
    }
});

// Runs once per app launch/login — checks every "Watched" TV show against
// TMDB's current episode count, not just whichever show you happen to open,
// so a new season gets caught even if you never revisit that show's page.
// Fully non-blocking: failures here shouldn't affect anything else.
async function checkForNewEpisodesInBackground() {
    let updated;
    try {
        updated = await window.api.checkForNewEpisodes();
    } catch (err) {
        console.error('Background new-episodes check failed:', err);
        return;
    }
    // Refreshes episode counts/season art for every tracked show even when
    // nothing flipped status — the entries cache needs invalidating either way,
    // or those refreshed numbers wouldn't show up until a full restart.
    invalidateEntriesCache();
    if (!updated || updated.length === 0) return;

    // One combined notification rather than spamming one per show.
    const body = updated.length === 1
        ? `${updated[0].title} has new episodes to watch.`
        : `${updated.map((u) => u.title).join(', ')} have new episodes to watch.`;
    try {
        await window.api.showNotification('New episodes available', body);
    } catch (err) {
        console.error('Failed to show notification:', err);
    }
    // Refresh the dashboard if it's already showing stale "Watched" data
    // for one of these — harmless no-op if you're not on a page it affects.
    if (SECTIONS[currentSection] && SECTIONS[currentSection].special !== 'lists' && !els.catalogPage.classList.contains('hidden')) {
        loadDashboard();
    }
}

const els = {
    navBtns: document.querySelectorAll('.nav-btn'),
    searchInput: document.getElementById('searchInput'),
    searchResultsDropdown: document.getElementById('searchResultsDropdown'),
    sectionNotice: document.getElementById('sectionNotice'),
    dashboardView: document.getElementById('dashboardView'),
    listsView: document.getElementById('listsView'),
    listDetailView: document.getElementById('listDetailView'),
    listDetailHero: document.getElementById('listDetailHero'),
    heroBanner: document.getElementById('heroBanner'),
    librarySearchInput: document.getElementById('librarySearchInput'),
    continueWatchingSection: document.getElementById('continueWatchingSection'),
    continueWatchingTitle: document.getElementById('continueWatchingTitle'),
    continueWatchingRow: document.getElementById('continueWatchingRow'),
    queueSection: document.getElementById('queueSection'),
    queueTitle: document.getElementById('queueTitle'),
    queueRow: document.getElementById('queueRow'),
    nextWatchSection: document.getElementById('nextWatchSection'),
    nextWatchTitle: document.getElementById('nextWatchTitle'),
    nextWatchRow: document.getElementById('nextWatchRow'),
    seriesNextSection: document.getElementById('seriesNextSection'),
    seriesNextTitle: document.getElementById('seriesNextTitle'),
    seriesNextRow: document.getElementById('seriesNextRow'),
    catalogPage: document.getElementById('catalogPage'),
    detailPage: document.getElementById('detailPage'),
    detailContent: document.getElementById('detailContent'),
    detailBackBtn: document.getElementById('detailBackBtn'),
    personPage: document.getElementById('personPage'),
    profilePage: document.getElementById('profilePage'),
    accountPage: document.getElementById('accountPage'),
    personContent: document.getElementById('personContent'),
    personBackBtn: document.getElementById('personBackBtn'),
    searchPage: document.getElementById('searchPage'),
    searchBackBtn: document.getElementById('searchBackBtn'),
    searchPageTitle: document.getElementById('searchPageTitle'),
    searchPageResults: document.getElementById('searchPageResults'),
    nextWatchRouletteBtn: document.getElementById('nextWatchRouletteBtn'),
    seriesNextRouletteBtn: document.getElementById('seriesNextRouletteBtn'),
    rouletteOverlay: document.getElementById('rouletteOverlay'),
    rouletteHeading: document.getElementById('rouletteHeading'),
    rouletteTrack: document.getElementById('rouletteTrack'),
    rouletteResult: document.getElementById('rouletteResult'),
    rouletteResultPoster: document.getElementById('rouletteResultPoster'),
    rouletteResultTitle: document.getElementById('rouletteResultTitle'),
    rouletteCloseBtn: document.getElementById('rouletteCloseBtn'),
    rouletteSpinAgainBtn: document.getElementById('rouletteSpinAgainBtn'),
    rouletteSaveBtn: document.getElementById('rouletteSaveBtn'),
    rouletteOpenBtn: document.getElementById('rouletteOpenBtn'),
};

// ---------------- custom dropdown (replaces native <select> — Windows can't
// be restyled once opened, so we build our own instead) ----------------

function createCustomSelect({ container, options, value, onChange }) {
    container.innerHTML = `
        <div class="custom-select">
            <div class="custom-select-trigger">
                <span class="custom-select-label"></span>
                <svg class="custom-select-chevron" viewBox="0 0 24 24" width="14" height="14">
                    <polyline points="6 9 12 15 18 9" fill="none" stroke="currentColor" stroke-width="2.5"/>
                </svg>
            </div>
            <div class="custom-select-menu hidden">
                ${options.map((o) => `<div class="custom-select-option" data-value="${o.value}">${o.label}</div>`).join('')}
            </div>
        </div>
    `;
    const root = container.querySelector('.custom-select');
    const trigger = root.querySelector('.custom-select-trigger');
    const label = root.querySelector('.custom-select-label');
    const menu = root.querySelector('.custom-select-menu');
    let current = value;

    function setValue(v, fire) {
        current = v;
        const opt = options.find((o) => o.value === v);
        label.textContent = opt ? (opt.triggerLabel || opt.label) : '';
        root.querySelectorAll('.custom-select-option').forEach((el) => {
            el.classList.toggle('selected', el.dataset.value === v);
        });
        if (fire) onChange(v);
    }
    setValue(value, false);

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.custom-select-menu').forEach((m) => {
            if (m !== menu) m.classList.add('hidden');
        });
        document.querySelectorAll('.custom-select').forEach((s) => { if (s !== root) s.classList.remove('open'); });
        menu.classList.toggle('hidden');
        root.classList.toggle('open');
    });

    root.querySelectorAll('.custom-select-option').forEach((el) => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            setValue(el.dataset.value, true);
            menu.classList.add('hidden');
            root.classList.remove('open');
        });
    });

    return { getValue: () => current, setValue: (v) => setValue(v, false) };
}

document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.custom-select').forEach((s) => s.classList.remove('open'));
    document.querySelectorAll('.status-dropdown-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.status-dropdown').forEach((s) => s.classList.remove('open'));
    document.querySelectorAll('.list-add-dropdown-menu').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.list-add-dropdown').forEach((s) => s.classList.remove('open'));
});

// ---------------- custom date input (DD/MM/YYYY, typeable + calendar) ----------------
// Native <input type=date> always displays in the OS/browser locale format —
// the `lang` attribute has NO effect on that (only on server-side spec
// wording, not actual rendering). The only way to guarantee DD/MM/YYYY
// regardless of the user's Windows locale is to not use the native picker.

function isoToDMY(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}
function dmyToIso(dmy) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy.trim());
    if (!match) return null;
    const [, d, m, y] = match;
    return `${y}-${m}-${d}`;
}
function isoToLocalDate(iso) {
    // `new Date('2024-03-15')` parses as UTC midnight, which can render as
    // the previous day in timezones behind UTC (e.g. Brazil, UTC-3). This
    // builds the Date from the numeric parts directly, in local time,
    // avoiding that off-by-one-day bug entirely.
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}
function todayISOLocal() {
    // toISOString() reports UTC — in the evening in a timezone behind UTC
    // (e.g. Brazil, UTC-3), that can already be "tomorrow" in UTC. This
    // builds today's date from local components instead.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function createDateInput({ container, initialISO, onChange }) {
    container.innerHTML = `
        <div class="date-input-wrap">
            <input type="text" class="date-input" placeholder="dd/mm/yyyy" maxlength="10"
                   value="${isoToDMY(initialISO)}">
            <button type="button" class="date-cal-btn" title="Pick a date">
                <svg viewBox="0 0 24 24" width="16" height="16"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/><line x1="8" y1="3" x2="8" y2="7" stroke="currentColor" stroke-width="2"/><line x1="16" y1="3" x2="16" y2="7" stroke="currentColor" stroke-width="2"/></svg>
            </button>
            <div class="date-cal-popup hidden"></div>
        </div>
    `;
    const root = container.querySelector('.date-input-wrap');
    const textInput = root.querySelector('.date-input');
    const calBtn = root.querySelector('.date-cal-btn');
    const popup = root.querySelector('.date-cal-popup');
    let currentISO = initialISO || null;
    let viewDate = currentISO ? isoToLocalDate(currentISO) : new Date();
    // Distinguishes "deliberately don't know/remember" (the No Date button)
    // from "just haven't touched this field yet" — both are stored as the
    // same null, but only the former should stop the auto-fill-today
    // convenience elsewhere from quietly overwriting it with a guess.
    let explicitlyCleared = false;

    // auto-insert slashes as the person types digits
    textInput.addEventListener('input', () => {
        let digits = textInput.value.replace(/\D/g, '').slice(0, 8);
        let formatted = digits;
        if (digits.length > 4) formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
        else if (digits.length > 2) formatted = `${digits.slice(0, 2)}/${digits.slice(2)}`;
        textInput.value = formatted;
        const iso = dmyToIso(formatted);
        if (iso) {
            currentISO = iso;
            explicitlyCleared = false;
            viewDate = isoToLocalDate(iso); // keep the calendar in sync with what's typed
            onChange?.(iso);
        } else if (formatted === '') {
            currentISO = null;
            onChange?.(null);
        }
    });

    function renderCalendar() {
        const year = viewDate.getFullYear();
        const month = viewDate.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const monthName = viewDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

        let cells = '';
        for (let i = 0; i < firstDay; i++) cells += '<div></div>';
        for (let d = 1; d <= daysInMonth; d++) {
            const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const selected = iso === currentISO ? 'selected' : '';
            cells += `<button type="button" class="date-cal-day ${selected}" data-iso="${iso}">${d}</button>`;
        }

        popup.innerHTML = `
            <div class="date-cal-header">
                <button type="button" class="date-cal-nav" data-dir="-1">&#10094;</button>
                <span>${monthName}</span>
                <button type="button" class="date-cal-nav" data-dir="1">&#10095;</button>
            </div>
            <div class="date-cal-weekdays">${['Mo','Tu','We','Th','Fr','Sa','Su'].map((d) => `<span>${d}</span>`).join('')}</div>
            <div class="date-cal-grid">${cells}</div>
            <div class="date-cal-footer">
                <button type="button" class="date-cal-clear${!currentISO ? ' active' : ''}">No Date</button>
            </div>
        `;
        popup.querySelectorAll('.date-cal-nav').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                viewDate = new Date(year, month + Number(btn.dataset.dir), 1);
                renderCalendar();
            });
        });
        popup.querySelectorAll('.date-cal-day').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                currentISO = btn.dataset.iso;
                explicitlyCleared = false;
                textInput.value = isoToDMY(currentISO);
                onChange?.(currentISO);
                popup.classList.add('hidden');
            });
        });
        popup.querySelector('.date-cal-clear').addEventListener('click', (e) => {
            e.stopPropagation();
            currentISO = null;
            explicitlyCleared = true;
            textInput.value = '';
            onChange?.(null); // a real save, same as picking an actual day — not just an untouched blank field
            popup.classList.add('hidden');
        });
    }

    calBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willShow = popup.classList.contains('hidden');
        document.querySelectorAll('.date-cal-popup').forEach((p) => p.classList.add('hidden'));
        if (willShow) { renderCalendar(); popup.classList.remove('hidden'); }
    });

    return {
        getISO: () => currentISO,
        setISO: (iso) => { currentISO = iso; explicitlyCleared = false; textInput.value = isoToDMY(iso); },
        wasExplicitlyCleared: () => explicitlyCleared,
    };
}

document.addEventListener('click', () => {
    document.querySelectorAll('.date-cal-popup').forEach((p) => p.classList.add('hidden'));
});

const TYPE_LABELS = { movie: 'Film', tv: 'TV Series', book: 'Book', game: 'Videogame' };
// Plural form for "Related X" / "Similar X" section headings.
const TYPE_LABELS_PLURAL = { movie: 'Films', tv: 'Series', book: 'Books', game: 'Videogames' };
// Small colored corner marker for posters outside your own library grid
// (related/similar titles, a person's filmography) — flags a title you've
// already added, in its status color. Nothing renders if there's no status.
function statusFlag(status) {
    return status ? `<span class="status-flag flag-${status}"></span>` : '';
}

// Each nav entry maps to a slice of the catalog. `mediaTypes: null` means "everything".
const SECTIONS = {
    home: { mediaTypes: null, labelType: null, title: 'Home',
             emptyText: 'Nothing added yet — search above to add a movie, series, book, or game.' },
    watched: { mediaTypes: ['movie', 'tv'], labelType: 'movie', title: 'Watch',
             emptyText: 'Nothing here yet — search above to add a movie or series.' },
    read: { mediaTypes: ['book'], labelType: 'book', title: 'Read',
             emptyText: 'Nothing here yet — search above to add a book.' },
    played: { mediaTypes: ['game'], labelType: 'game', title: 'Play',
             emptyText: 'Nothing here yet — search above to add a game.' },
    lists: { special: 'lists', title: 'Lists', emptyText: 'Custom lists are coming soon.' },
};

let currentSection = 'home';
// Wording for the dashboard rows depends on which section you're in (Watch / Read / Play).
function sectionWords() {
    if (currentSection === 'read') return { hero: 'Saved to Read', cont: 'Continue Reading', next: 'Your Next Read', ing: 'Reading' };
    if (currentSection === 'played') return { hero: 'Saved to Play', cont: 'Continue Playing', next: 'Your Next Play', ing: 'Playing' };
    return { hero: 'Saved to Watch', cont: 'Continue Watching', next: 'Your Next Watch', ing: 'Watching' };
}
let allEntries = [];    // unfiltered entries for the current section, cached client-side
let searchDebounceTimer = null;

// ---------------- window controls (custom titlebar, frame: false) ----------------

// ---------------- fullscreen poster lightbox ----------------

const lightboxEl = document.getElementById('imageLightbox');
const lightboxImg = document.getElementById('lightboxImg');

function openLightbox(src) {
    lightboxImg.src = src;
    lightboxEl.classList.remove('hidden');
}
function closeLightbox() {
    lightboxEl.classList.add('hidden');
    lightboxImg.src = '';
}
document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
lightboxEl.addEventListener('click', (e) => { if (e.target === lightboxEl) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

// ---------------- styled confirm modal (replaces native confirm()) ----------------

const confirmModalEl = document.getElementById('confirmModal');
const confirmModalMessage = document.getElementById('confirmModalMessage');
const confirmModalOk = document.getElementById('confirmModalOk');
const confirmModalCancel = document.getElementById('confirmModalCancel');
let confirmModalResolve = null;

function showConfirm(message, { confirmLabel = 'Remove' } = {}) {
    confirmModalMessage.textContent = message;
    confirmModalOk.textContent = confirmLabel;
    confirmModalEl.classList.remove('hidden');
    return new Promise((resolve) => { confirmModalResolve = resolve; });
}
function closeConfirmModal(result) {
    confirmModalEl.classList.add('hidden');
    confirmModalResolve?.(result);
    confirmModalResolve = null;
}
confirmModalOk.addEventListener('click', () => closeConfirmModal(true));
confirmModalCancel.addEventListener('click', () => closeConfirmModal(false));
confirmModalEl.addEventListener('click', (e) => { if (e.target === confirmModalEl) closeConfirmModal(false); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !confirmModalEl.classList.contains('hidden')) closeConfirmModal(false);
});

// ---------------- toast notifications (bottom-right confirmation) ----------------

const toastContainer = document.getElementById('toastContainer');
function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast ${isError ? 'toast-error' : ''}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

document.getElementById('winMinimize').addEventListener('click', () => window.api.minimizeWindow());
document.getElementById('winMaximize').addEventListener('click', () => window.api.maximizeWindow());
document.getElementById('winClose').addEventListener('click', () => window.api.closeWindow());

// ---------------- page switching ----------------

// A stack of prior views (catalog/detail/person) — Back pops the last one
// instead of always dumping you at the catalog, so a chain like
// "Movie A -> cast member -> Movie B -> cast member" unwinds correctly
// step by step instead of skipping straight to the top every time.
let navHistory = [];
// Remember where the page was scrolled when leaving it, so Back can return to the same spot.
function pushNav(view) {
    if (view && typeof view === 'object') view.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    navHistory.push(view);
}
let scrollRestoreToken = 0;
function restoreScroll(y) {
    if (!y) return;
    const token = ++scrollRestoreToken;
    const cancel = () => { scrollRestoreToken++; };
    ['wheel', 'touchmove', 'keydown', 'mousedown'].forEach((ev) => window.addEventListener(ev, cancel, { once: true, passive: true }));
    [0, 60, 150, 300, 500, 800, 1200, 1800, 2600].forEach((ms) => setTimeout(() => {
        if (token !== scrollRestoreToken) return;
        if (document.documentElement.scrollHeight >= y + window.innerHeight * 0.4) window.scrollTo(0, y);
    }, ms));
}
let currentView = { type: 'catalog' };

function showPage(page) {
    els.catalogPage.classList.toggle('hidden', page !== 'catalog');
    els.detailPage.classList.toggle('hidden', page !== 'detail');
    els.personPage.classList.toggle('hidden', page !== 'person');
    els.profilePage.classList.toggle('hidden', page !== 'profile');
    els.accountPage.classList.toggle('hidden', page !== 'account');
    els.searchPage.classList.toggle('hidden', page !== 'search');
    document.getElementById('collectionPage').classList.toggle('hidden', page !== 'collection');
    document.getElementById('officialAccountPage').classList.toggle('hidden', page !== 'officialAccount');
    // the profile/account pages aren't one of the top tabs — don't leave the last tab lit
    if (page === 'profile' || page === 'account' || page === 'officialAccount') els.navBtns.forEach((b) => b.classList.remove('active'));
    window.scrollTo(0, 0);
}

function goToCatalog() {
    currentView = { type: 'catalog' };
    els.navBtns.forEach((b) => b.classList.toggle('active', b.dataset.section === currentSection));
    showPage('catalog');
    // The detail/person page can change status, progress, rating, etc. —
    // refresh the row you're returning to instead of leaving it showing
    // whatever it looked like before you clicked in.
    if (SECTIONS[currentSection].special !== 'lists') loadDashboard();
}

function goBack() {
    const prev = navHistory.pop();
    if (prev && prev.scrollY) restoreScroll(prev.scrollY);
    if (!prev || prev.type === 'catalog') { goToCatalog(); return; }
    if (prev.type === 'detail') { openDetails(prev.tmdbId, prev.mediaType, { recordHistory: false }); return; }
    if (prev.type === 'statsFilter') { openStatsFilter(prev.f, { recordHistory: false }); return; }
    if (prev.type === 'studio') { openStudio(prev.kind, prev.id, { recordHistory: false }); return; }
    if (prev.type === 'person') { openPerson(prev.personId, { recordHistory: false }); return; }
    if (prev.type === 'profile') { openProfilePage({ recordHistory: false }); return; }
    if (prev.type === 'account') { openAccountPage({ recordHistory: false }); return; }
    if (prev.type === 'officialAccount') { openOfficialAccountPage({ recordHistory: false }); return; }
    if (prev.type === 'collection') { openCollectionPage(prev.g, prev.watched, { recordHistory: false }); return; }
    if (prev.type === 'search') { openSearchResults(prev.query, { recordHistory: false, page: prev.page || 1 }); return; }
}

els.detailBackBtn.addEventListener('click', goBack);
els.personBackBtn.addEventListener('click', goBack);
els.searchBackBtn.addEventListener('click', goBack);

// ---------------- navigation (HOME/PLAYED/READ/WATCHED/LISTS) ----------------

els.navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        els.navBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        // A top-level tab switch is a fresh start, not a continuation of
        // whatever you were drilling into — clear the trail rather than
        // letting Back later pop into a stale detail/person page.
        navHistory = [];
        currentView = { type: 'catalog' };
        showPage('catalog');
        switchSection(btn.dataset.section);
    });
});

function switchSection(sectionKey) {
    currentSection = sectionKey;
    if (!sectionKey || sectionKey !== 'lists') { listReturn = null; setListBackLabel('Back to Lists'); }
    const cfg = SECTIONS[sectionKey];

    els.dashboardView.classList.add('hidden');
    els.listsView.classList.add('hidden');
    els.listDetailView.classList.add('hidden');
    els.sectionNotice.classList.add('hidden');

    if (cfg.special === 'lists') {
        els.listsView.classList.remove('hidden');
        loadListsPage();
        return;
    }

    loadDashboard();
}

// ==================== CUSTOM LISTS ====================

let listsActiveTab = 'mine'; // 'mine' | 'shared'
let listsCache = { mine: [], shared: [], official: [] };
let officialSources = [];
let officialAdmin = false;
let officialAutoRan = false;
let officialSourcesError = '';
const LIST_VISIBILITY_OPTIONS = [
    { value: 'public', label: 'Anyone — Public list' },
    { value: 'link', label: 'Anyone with share link' },
    { value: 'friends', label: 'Friends (people you follow) with share link' },
    { value: 'private', label: 'You (private list)' },
];
let listEditVisibility = 'private';
function renderListEditVisibility() {
    createCustomSelect({
        container: document.getElementById('listEditVisibility'),
        options: LIST_VISIBILITY_OPTIONS,
        value: listEditVisibility,
        onChange: (v) => { listEditVisibility = v; },
    });
}
let listsFilter = { show: 'all', sort: 'custom', ascending: false };
let currentListDetail = null;

function syncHeaderHeight() {
    const h = document.querySelector('header');
    if (!h) return;
    const bottom = h.getBoundingClientRect().bottom;
    if (bottom > 0) document.documentElement.style.setProperty('--hdr-h', `${Math.round(bottom)}px`);
}
window.addEventListener('resize', syncHeaderHeight);
syncHeaderHeight();
setTimeout(syncHeaderHeight, 300); // once fonts/layout settle

function setCatalogLoading(on) {
    if (on) syncHeaderHeight();
    document.getElementById('catalogLoading').classList.toggle('hidden', !on);
}

async function loadListsPage() {
    const requestedSection = currentSection;
    if (!listsCache.mine.length && !listsCache.shared.length) { els.listsView.classList.add('hidden'); setCatalogLoading(true); }
    let mine, shared, official = [];
    try {
        [mine, shared, official] = await Promise.all([
            window.api.listMyLists(),
            window.api.listSharedLists(),
            window.api.listOfficialPublicLists().catch(() => []),
        ]);
        officialSourcesError = '';
        officialSources = await window.api.listOfficialLists().catch((e) => { officialSourcesError = e.message || String(e); return []; });
        officialAdmin = await window.api.isOfficialAdmin().catch(() => false);
        // Fallback if the admin function isn't in the database yet: the owner of an official list can always fill it.
        if (!officialAdmin) officialAdmin = (official || []).some((l) => l.is_mine);
    } finally {
        if (currentSection === requestedSection) setCatalogLoading(false);
    }
    if (currentSection !== requestedSection) return; // navigated elsewhere while this was loading
    if (els.listDetailView.classList.contains('hidden')) els.listsView.classList.remove('hidden');
    const sig = (arr) => (arr || []).map((l) => `${l.id}:${l.updated_at}:${l.item_count}`).join('|');
    if (profileListsCache && sig(mine) !== sig(profileListsCache)) profileStale = true; // lists changed since the profile loaded
    listsCache = { mine, shared, official };
    renderListsControls();
    renderListsGrid();
    // The official lists fill themselves the first time an admin opens Lists — no button needed.
    if (officialAdmin && !officialAutoRan && officialPending().length) { officialAutoRan = true; runOfficialImport(); }
}

// Show-filter categories (with live counts, Letterboxd-style). Lists only
// share with family members, so "Shared with Family" / "Private" are the
// two real states there are.
function listsInActiveTab() {
    return listsCache[listsActiveTab] || [];
}
function listMatchesShowFilter(l, show) {
    if (show === 'family') return listsActiveTab === 'shared' || l.share_count > 0;
    if (show === 'private') return listsActiveTab === 'mine' && !l.share_count && (!l.visibility || l.visibility === 'private');
    // No public/friends sharing exists in the backend yet; these light up
    // once lists carry a `visibility` of 'public' / 'friends'.
    if (show === 'anyone') return l.visibility === 'public' || l.visibility === 'link';
    if (show === 'friends') return l.visibility === 'friends';
    return true;
}

function renderListsControls() {
    const all = listsInActiveTab();
    const countFor = (show) => all.filter((l) => listMatchesShowFilter(l, show)).length;
    const countLabel = (label, n) => `${label}  ${n}`;
    const opt = (value, label) => ({ value, label: countLabel(label, countFor(value)), triggerLabel: `Show ${label}` });
    createCustomSelect({
        container: document.getElementById('listsShowFilter'),
        options: [
            opt('all', 'All'),
            opt('anyone', 'Shared with Anyone'),
            opt('friends', 'Shared with Friends'),
            opt('family', 'Shared with Family'),
            opt('private', 'Private'),
        ],
        value: listsFilter.show,
        onChange: (v) => { listsFilter.show = v; renderListsGrid(); },
    });
    createCustomSelect({
        container: document.getElementById('listsSortSelect'),
        options: [
            { value: 'custom', label: 'Sort by List Order' },
            { value: 'updated', label: 'When Updated' },
            { value: 'created', label: 'When Created' },
            { value: 'alphabetical', label: 'Alphabetical' },
            { value: 'count', label: 'Number of Items' },
            { value: 'likes', label: 'Most Liked' },
        ],
        value: listsFilter.sort,
        onChange: (v) => { listsFilter.sort = v; renderListsGrid(); },
    });
    const dirBtn = document.getElementById('listsSortDir');
    dirBtn.classList.toggle('ascending', listsFilter.ascending);
    dirBtn.classList.toggle('hidden', listsFilter.sort === 'custom'); // manual order has no direction
    dirBtn.onclick = () => {
        listsFilter.ascending = !listsFilter.ascending;
        dirBtn.classList.toggle('ascending', listsFilter.ascending);
        renderListsGrid();
    };
}

document.getElementById('listsTabMine').addEventListener('click', () => {
    listsActiveTab = 'mine';
    document.getElementById('listsTabMine').classList.add('active');
    document.getElementById('listsTabShared').classList.remove('active');
    document.getElementById('listsTabOfficial').classList.remove('active');
    renderListsGrid();
});
document.getElementById('listsTabShared').addEventListener('click', () => {
    listsActiveTab = 'shared';
    document.getElementById('listsTabShared').classList.add('active');
    document.getElementById('listsTabMine').classList.remove('active');
    document.getElementById('listsTabOfficial').classList.remove('active');
    renderListsGrid();
});
document.getElementById('listsTabOfficial').addEventListener('click', () => {
    listsActiveTab = 'official';
    document.getElementById('listsTabOfficial').classList.add('active');
    document.getElementById('listsTabMine').classList.remove('active');
    document.getElementById('listsTabShared').classList.remove('active');
    renderListsGrid();
});

document.getElementById('listsNewBtn').addEventListener('click', () => {
    // Nothing is actually created yet — this is a local-only draft until
    // Save is clicked or a title gets added (ensureListCreated handles
    // that lazily), so backing out without doing either leaves no trace.
    currentListDetail = { id: null, name: 'Untitled List', description: '', genres: [], is_ranked: false, visibility: 'private', items: [], isOwner: true };
    els.listsView.classList.add('hidden');
    els.listDetailView.classList.remove('hidden');
    document.getElementById('listDetailGrid').innerHTML = '';
    document.getElementById('listAddSearchInput').value = '';
    document.getElementById('listAddSearchResults').innerHTML = '';
    renderListDetail();
    // Drop straight into editing so naming it is the very next thing —
    // matches clicking "+ New List" going straight to a full edit page.
    document.getElementById('listDetailEditBtn').click();
    document.getElementById('listEditNameInput').focus();
    document.getElementById('listEditNameInput').select();
});

// Lazily creates the draft list for real the first time it's actually
// needed (Save, or adding a title) — called from both of those places.
async function ensureListCreated() {
    if (currentListDetail.id) return currentListDetail.id;
    const editForm = document.getElementById('listDetailEditForm');
    if (!editForm.classList.contains('hidden')) {
        // Pull in whatever's currently typed but not yet saved, so adding a
        // title before clicking Save still keeps that name/genres/etc.
        currentListDetail.name = document.getElementById('listEditNameInput').value.trim() || currentListDetail.name;
        currentListDetail.description = document.getElementById('listEditDescInput').value.trim();
        currentListDetail.is_ranked = document.getElementById('listEditRankedInput').checked;
        currentListDetail.genres = [...listEditGenres];
        currentListDetail.visibility = listEditVisibility;
    }
    const created = await window.api.createList(currentListDetail.name, currentListDetail.description, currentListDetail.genres, currentListDetail.is_ranked, currentListDetail.visibility);
    currentListDetail.id = created.id;
    currentListDetail.created_at = created.created_at;
    currentListDetail.updated_at = created.updated_at;
    return currentListDetail.id;
}

function renderListsGrid() {
    const grid = document.getElementById('listsGrid');
    renderListsControls(); // counts in the Show filter follow the active tab
    renderOfficialSetupBanner();
    let items = listsInActiveTab().filter((l) => listMatchesShowFilter(l, listsFilter.show));

    const sorted = [...items];
    switch (listsFilter.sort) {
        case 'custom':
            // The user's own manual order first; anything never placed yet
            // follows, most recently updated first.
            sorted.sort((a, b) => {
                const ap = a.custom_position, bp = b.custom_position;
                if (ap != null && bp != null) return ap - bp;
                if (ap != null) return -1;
                if (bp != null) return 1;
                return new Date(b.updated_at) - new Date(a.updated_at);
            });
            break;
        case 'created': sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); break;
        case 'alphabetical': sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
        case 'count': sorted.sort((a, b) => a.item_count - b.item_count); break;
        case 'likes': sorted.sort((a, b) => (a.like_count || 0) - (b.like_count || 0)); break;
        case 'updated':
        default: sorted.sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)); break;
    }
    if (!listsFilter.ascending && listsFilter.sort !== 'custom') sorted.reverse();
    if (listsActiveTab === 'mine') sorted.sort((a, b) => Number(Boolean(b.is_favorites)) - Number(Boolean(a.is_favorites))); // Favorite Titles always on top

    // Only the owner can create lists from here — "Shared With You" is
    // read-only browsing of what other family members shared, same as the
    // rest of that page's items are read-only for a non-owner.
    document.getElementById('listsNewBtn').classList.toggle('hidden', listsActiveTab !== 'mine');

    if (!sorted.length) {
        grid.innerHTML = listsActiveTab === 'mine'
            ? `<p class="profile-tab-empty">No lists yet. <a href="#" id="listsStartOneLink">Start one?</a></p>`
            : listsActiveTab === 'official' ? `<p class="profile-tab-empty">No official lists yet.</p>`
            : `<p class="profile-tab-empty">Nothing has been shared with you yet.</p>`;
        const startLink = document.getElementById('listsStartOneLink');
        if (startLink) {
            startLink.addEventListener('click', (e) => {
                e.preventDefault();
                document.getElementById('listsNewBtn').click();
            });
        }
        return;
    }

    // Dragging only makes sense for the manual order, and only while the
    // full list is on screen (a filtered subset would scramble positions).
    const canReorderLists = listsActiveTab === 'mine' && listsFilter.sort === 'custom' && listsFilter.show === 'all';
    grid.innerHTML = sorted.map((l) => {
        const posters = l.preview_posters || [];
        return `
        <div class="list-card${canReorderLists ? ' list-card--draggable' : ''}" data-list-id="${l.id}"${canReorderLists ? ' draggable="true"' : ''}>
            <div class="list-card-pile">
                ${posters.length ? posters.map((p, i) => `
                    <img class="list-card-pile-poster" src="${imgSrc(p)}" alt="" style="z-index:${posters.length - i};" loading="lazy">
                `).join('') : `<div class="list-card-pile-empty">No titles yet</div>`}
            </div>
            <div class="list-card-info">
                <div class="list-card-name">${escapeHtml(l.name)}</div>
                <div class="list-card-meta">
                    ${l.item_count} ${l.item_count === 1 ? 'title' : 'titles'}${l.owner_name ? ` · by ${escapeHtml(l.owner_name)}` : ''}${l.like_count ? ` · <span class="list-card-likes">&#9829; ${l.like_count}</span>` : ''}${l.share_count && listsActiveTab === 'mine' ? ' · Shared with family' : ''}
                    ${listsActiveTab === 'mine' ? `<button type="button" class="list-card-edit-btn" data-edit-list="${l.id}" title="Edit list">&#9998;</button>` : ''}
                </div>
                ${l.description ? `<div class="list-card-desc">${escapeHtml(l.description)}</div>` : ''}
                ${(l.genres || []).length ? `<div class="list-card-genres">${l.genres.map((g) => escapeHtml(g).toUpperCase()).join(' &nbsp; ')}</div>` : ''}
            </div>
        </div>
    `;
    }).join('');
    grid.querySelectorAll('[data-edit-list]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await openListDetail(Number(btn.dataset.editList));
            document.getElementById('listDetailEditBtn').click();
        });
    });
    grid.querySelectorAll('.list-card').forEach((card) => {
        card.addEventListener('click', () => openListDetail(Number(card.dataset.listId)));
    });
    if (canReorderLists) wireListsGridDragDrop(grid);
}

// Drag-to-reorder for the Lists page ("Sort by List Order") — same
// "closest card below the cursor" technique as the list-items reorder.
let draggedListCard = null;
function wireListsGridDragDrop(container) {
    container.querySelectorAll('.list-card').forEach((card) => {
        card.addEventListener('dragstart', () => { draggedListCard = card; card.classList.add('dragging'); });
        card.addEventListener('dragend', async () => {
            card.classList.remove('dragging');
            draggedListCard = null;
            const ids = [...container.querySelectorAll('.list-card')].map((c) => Number(c.dataset.listId));
            const pool = listsInActiveTab();
            ids.forEach((id, i) => { const l = pool.find((x) => x.id === id); if (l) l.custom_position = i + 1; });
            try {
                await window.api.reorderMyLists(ids);
            } catch (err) {
                showToast(`Couldn't save the new order: ${err.message}`, true);
            }
        });
    });
    container.ondragover = (e) => {
        e.preventDefault();
        if (!draggedListCard) return;
        const rows = [...container.querySelectorAll('.list-card:not(.dragging)')];
        const after = rows.reduce((closest, row) => {
            const box = row.getBoundingClientRect();
            const offset = e.clientY - box.top - box.height / 2;
            return (offset < 0 && offset > closest.offset) ? { offset, element: row } : closest;
        }, { offset: -Infinity, element: null }).element;
        if (after == null) container.appendChild(draggedListCard);
        else container.insertBefore(draggedListCard, after);
    };
}

async function openListDetail(listId) {
    els.listsView.classList.add('hidden');
    els.listDetailView.classList.remove('hidden');
    els.listDetailView.classList.add('list-detail-loading');
    setCatalogLoading(false); // never two spinners at once
    document.getElementById('listDetailLoading').classList.remove('hidden');
    els.listDetailHero.classList.add('hidden');
    els.listDetailHero.style.backgroundImage = 'none';
    document.getElementById('listDetailGrid').innerHTML = '';
    document.getElementById('listAddSearchInput').value = '';
    document.getElementById('listAddSearchResults').innerHTML = '';
    listDetailFilter = { decade: null, genre: null, sort: 'list_order', ascending: true }; // fresh filters per list opened
    listManageGridView = false;
    listManageSort = 'list_order';
    try {
        currentListDetail = await window.api.getList(listId);
        document.getElementById('listDetailEditForm').classList.add('hidden');
        renderListDetail();
    } catch (err) {
        showToast(`Couldn't load list: ${err.message}`, true);
        closeListDetail();
    } finally {
        els.listDetailView.classList.remove('list-detail-loading');
        document.getElementById('listDetailLoading').classList.add('hidden');
    }
}

// A rough "Updated 6 days ago" label, Letterboxd-style — no need for
// anything finer-grained than days/weeks/months here.
function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diffMs / 86400000);
    if (days <= 0) return 'Updated today';
    if (days === 1) return 'Updated yesterday';
    if (days < 7) return `Updated ${days} days ago`;
    if (days < 30) return `Updated ${Math.floor(days / 7)} week${Math.floor(days / 7) === 1 ? '' : 's'} ago`;
    if (days < 365) return `Updated ${Math.floor(days / 30)} month${Math.floor(days / 30) === 1 ? '' : 's'} ago`;
    return `Updated ${Math.floor(days / 365)} year${Math.floor(days / 365) === 1 ? '' : 's'} ago`;
}

// The header card itself (name/owner/description/genres/stats/actions) is
// static markup inside #listDetailHero — this just supplies the dark
// backdrop behind it (the first title's backdrop, same idea as the Home
// page's hero banner) and the owner avatar/name/updated-date line.
function renderListDetailHero(list) {
    const firstItem = list.items[0];
    const backdrop = firstItem ? (firstItem.backdrop_url || firstItem.poster_url || '') : '';
    // Nothing to show as a banner for an empty list yet — skip the empty
    // grey box rather than reserving space for a backdrop that isn't there.
    els.listDetailHero.classList.toggle('hidden', !backdrop);
    els.listDetailHero.style.backgroundImage = backdrop ? `url('${backdrop}')` : 'none';

    // Your own lists (including a not-yet-saved draft) show your real
    // name/photo, pulled from your profile when the list itself has none.
    const paintOwner = (name, avatarUrl, avatarColor, seed) => {
        const avatarEl = document.getElementById('listDetailOwnerAvatar');
        document.getElementById('listDetailOwnerName').textContent = name;
        if (avatarUrl) {
            avatarEl.style.background = 'transparent';
            avatarEl.innerHTML = `<img src="${avatarUrl}" alt="">`;
        } else {
            avatarEl.style.background = avatarColor || colorForId(String(seed || name));
            avatarEl.innerHTML = `<span>${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
        }
    };
    document.getElementById('listDetailUpdated').textContent = timeAgo(list.updated_at || list.created_at);
    paintOwner(list.owner_name || (list.isOwner ? 'you' : 'someone'), list.owner_avatar_url, list.owner_avatar_color, list.user_id);
    const hq = document.getElementById('listDetailOfficialBadge');
    hq.classList.toggle('hidden', !list.is_official);
    document.querySelector('.list-hero-owner-row').classList.toggle('official-owner-link', Boolean(list.is_official));
    if (list.is_official) {
        const av = document.getElementById('listDetailOwnerAvatar');
        av.style.background = 'transparent';
        av.innerHTML = '<img src="assets/official-icon.png" alt="">';
    }
    if (list.isOwner && !list.is_official && (!list.owner_name || !list.owner_avatar_url)) {
        (async () => {
            try {
                const [session, profile] = await Promise.all([window.api.getSession(), window.api.getProfile()]);
                if (currentListDetail !== list) return; // navigated elsewhere meanwhile
                const name = list.owner_name || profile?.display_name || session?.user?.email?.split('@')[0] || 'you';
                paintOwner(name, list.owner_avatar_url || profile?.avatar_url, list.owner_avatar_color || profile?.avatar_color, session?.user?.id);
            } catch { /* keep the fallback */ }
        })();
    }
}

function closeListDetail() {
    if (currentListDetail?.is_favorites) profileStale = true; // favorites order/visibility may have changed
    if (listReturn) {
        const r = listReturn;
        listReturn = null;
        setListBackLabel('Back to Lists');
        els.listDetailView.classList.add('hidden');
        els.navBtns.forEach((b) => b.classList.toggle('active', b.dataset.section === r.section));
        switchSection(r.section);
        if (r.view.type === 'catalog') return;
        pushNav(r.view);
        goBack();
        return;
    }
    els.listDetailView.classList.add('hidden');
    els.listsView.classList.remove('hidden');
    loadListsPage(); // item counts may have changed
}
document.getElementById('listDetailBackBtn').addEventListener('click', closeListDetail);

function isListEditing() {
    return !document.getElementById('listDetailEditForm').classList.contains('hidden');
}

// Real Decade/Genre/Sort filtering for the browsing-mode poster grid — same
// live-filter pattern as the Diary tab, just over list items instead of
// watch history. Lives outside renderListDetail() so a filter change can
// re-render just the grid without rebuilding the whole page.
let listDetailFilter = { decade: null, genre: null, sort: 'list_order', ascending: true };

// ---- editing-mode item-management toolbar (grid/list toggle + real Sort
// by, applied to the manageable row-list itself — resets per list opened) ----
let listManageGridView = false;
let listManageSort = 'list_order';
const LIST_MANAGE_GRID_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
const LIST_MANAGE_LIST_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>';
function setupListManageToolbar(list) {
    // A brand-new list doesn't exist yet: Cancel + Save only. Delete and
    // View list only make sense once it's real.
    const exists = Boolean(list.id);
    document.getElementById('listManageDeleteBtn').classList.toggle('hidden', !exists || Boolean(list.is_favorites));
    // Favorite Titles is filled with the heart button, not by searching.
    document.querySelector('#listDetailAddForm .list-add-input-row').classList.toggle('hidden', Boolean(list.is_favorites));
    document.getElementById('listManageViewBtn').classList.toggle('hidden', !exists);
    document.getElementById('listManageCancelBtn').classList.toggle('hidden', exists);
    const toggleBtn = document.getElementById('listViewToggleBtn');
    // Icon shows what clicking it switches TO, not the current mode — a
    // list icon while browsing the grid, a grid icon while browsing the list.
    toggleBtn.innerHTML = listManageGridView ? LIST_MANAGE_LIST_ICON : LIST_MANAGE_GRID_ICON;
    toggleBtn.title = listManageGridView ? 'Switch to list view' : 'Switch to grid view';
    toggleBtn.onclick = () => {
        listManageGridView = !listManageGridView;
        renderListDetail();
    };
    createCustomSelect({
        container: document.getElementById('listManageSort'),
        options: [
            { value: 'list_order', label: 'Sort by List Order' },
            { value: 'alphabetical', label: 'Alphabetical' },
            { value: 'release_date', label: 'Release Date' },
        ],
        value: listManageSort,
        onChange: async (v) => {
            listManageSort = v;
            if (v !== 'list_order') {
                const sorted = [...list.items];
                if (v === 'alphabetical') sorted.sort((a, b) => a.title.localeCompare(b.title));
                else if (v === 'release_date') sorted.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));
                list.items = sorted;
                if (list.id) {
                    try {
                        await window.api.reorderListItems(list.id, sorted.map((it) => it.id));
                    } catch (err) {
                        showToast(`Couldn't save the new order: ${err.message}`, true);
                    }
                }
            }
            renderListDetail();
        },
    });
}

function setupListDetailFilterBar(list) {
    const allGenres = [...new Set(list.items.flatMap((it) => {
        try { return JSON.parse(it.genres || '[]'); } catch { return []; }
    }))].sort();

    createCustomSelect({
        container: document.getElementById('listDetailDecadeFilter'),
        options: [{ value: '', label: 'Any Decade' }, ...Array.from({ length: 14 }, (_, i) => {
            const d = 2020 - i * 10;
            return { value: String(d), label: `${d}s` };
        })],
        value: listDetailFilter.decade != null ? String(listDetailFilter.decade) : '',
        onChange: (v) => { listDetailFilter.decade = v ? Number(v) : null; renderListDetailBrowsingGrid(currentListDetail); },
    });
    createCustomSelect({
        container: document.getElementById('listDetailGenreFilter'),
        options: [{ value: '', label: 'Any Genre' }, ...allGenres.map((g) => ({ value: g, label: g }))],
        value: listDetailFilter.genre || '',
        onChange: (v) => { listDetailFilter.genre = v || null; renderListDetailBrowsingGrid(currentListDetail); },
    });
    createCustomSelect({
        container: document.getElementById('listDetailSort'),
        options: [
            { value: 'list_order', label: 'Sort by List Order' },
            { value: 'alphabetical', label: 'Alphabetical' },
            { value: 'release_date', label: 'Release Date' },
        ],
        value: listDetailFilter.sort,
        onChange: (v) => { listDetailFilter.sort = v; renderListDetailBrowsingGrid(currentListDetail); },
    });
    const dirBtn = document.getElementById('listDetailSortDir');
    dirBtn.classList.toggle('ascending', listDetailFilter.ascending);
    dirBtn.onclick = () => {
        listDetailFilter.ascending = !listDetailFilter.ascending;
        dirBtn.classList.toggle('ascending', listDetailFilter.ascending);
        renderListDetailBrowsingGrid(currentListDetail);
    };
}

const LIST_PAGE_SIZE = 100;
let listDetailPage = 1;
let listDetailPageSig = '';
function renderListPager(pager, totalPages, rerender) {
    pager.classList.toggle('hidden', totalPages <= 1);
    if (totalPages <= 1) { pager.innerHTML = ''; return; }
    pager.innerHTML = `
        <div class="list-pager-pages">
            ${Array.from({ length: totalPages }, (_, i) => `<button type="button" class="list-pager-num${i + 1 === listDetailPage ? ' active' : ''}" data-page="${i + 1}">${i + 1}</button>`).join('')}
        </div>
        ${listDetailPage < totalPages ? '<button type="button" class="list-pager-next" data-page="next">Next</button>' : ''}
    `;
    pager.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
        listDetailPage = b.dataset.page === 'next' ? listDetailPage + 1 : Number(b.dataset.page);
        rerender();
        document.getElementById('listDetailGrid').scrollIntoView({ block: 'start' });
    }));
}

function renderListDetailBrowsingGrid(list) {
    const grid = document.getElementById('listDetailGrid');
    // Keep each item's real position in the saved list order, so the rank
    // badge on a Ranked list still reflects how it was actually ordered —
    // even once the grid itself is filtered or re-sorted for browsing.
    let filtered = list.items.map((item, i) => ({ ...item, _rank: i + 1 }));
    if (listDetailFilter.decade != null) filtered = filtered.filter((it) => decadeOf(it.release_date) === listDetailFilter.decade);
    if (listDetailFilter.genre) {
        filtered = filtered.filter((it) => { try { return JSON.parse(it.genres || '[]').includes(listDetailFilter.genre); } catch { return false; } });
    }

    switch (listDetailFilter.sort) {
        case 'alphabetical': filtered.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'release_date': filtered.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '')); break;
        case 'list_order':
        default: filtered.sort((a, b) => a._rank - b._rank); break;
    }
    if (!listDetailFilter.ascending) filtered.reverse();

    grid.className = 'poster-grid';
    const pager = document.getElementById('listDetailPager');
    if (!filtered.length) {
        grid.innerHTML = `<p class="profile-tab-empty">Nothing matches those filters.</p>`;
        pager.classList.add('hidden');
        return;
    }
    // Pages of 100 titles. Any change to the list or its filters starts back at page 1.
    const sig = JSON.stringify([list.id, list.items.length, listDetailFilter]);
    if (sig !== listDetailPageSig) { listDetailPageSig = sig; listDetailPage = 1; }
    const totalPages = Math.max(1, Math.ceil(filtered.length / LIST_PAGE_SIZE));
    listDetailPage = Math.min(listDetailPage, totalPages);
    const pageItems = filtered.slice((listDetailPage - 1) * LIST_PAGE_SIZE, listDetailPage * LIST_PAGE_SIZE);
    renderListPager(pager, totalPages, () => renderListDetailBrowsingGrid(list));
    filtered = pageItems;
    // Year badges when sorting by release date, no badge otherwise — list
    // items don't carry a watched/rated date to show, so every other sort
    // stays badge-free rather than showing something misleading.
    renderPosterGrid(grid, filtered, listDetailFilter.sort === 'release_date' ? 'release_date' : 'alphabetical');
    grid.querySelectorAll('.poster-card').forEach((card, i) => {
        const item = filtered[i];
        if (list.is_ranked) {
            const rankBadge = document.createElement('div');
            rankBadge.className = 'list-rank-badge';
            rankBadge.textContent = item._rank;
            card.appendChild(rankBadge);
        }
        if (item.status) {
            // Bookmark ribbon in the status colour (planned / watching / watched / dropped / rewatched).
            (card.querySelector('.poster-img-wrap') || card).insertAdjacentHTML('beforeend', statusFlag(item.status));
        }
    });
}

function renderListDetail() {
    const list = currentListDetail;
    const editing = isListEditing();
    renderListDetailHero(list);
    document.getElementById('listDetailName').textContent = list.name;
    const descEl = document.getElementById('listDetailDescription');
    descEl.textContent = list.description || '';
    descEl.classList.toggle('hidden', !list.description);
    const genresEl = document.getElementById('listDetailGenres');
    const genreList = list.genres || [];
    genresEl.innerHTML = genreList.map((g) => `<span class="list-genre-tag list-genre-tag--static">${escapeHtml(g)}</span>`).join('');
    genresEl.classList.toggle('hidden', !genreList.length);
    const watchedCount = list.items.filter((it) => it.watched).length;
    // The item count already lives in the "You've watched X of Y" stat box
    // below, so this line only needs whatever that box doesn't say.
    const metaEl = document.getElementById('listDetailMeta');
    const metaParts = [
        list.is_ranked ? 'Ranked' : null,
        !list.isOwner ? `shared by ${escapeHtml(list.owner_name || 'someone')}` : null,
    ].filter(Boolean);
    metaEl.textContent = metaParts.join(' · ');
    metaEl.classList.toggle('hidden', !metaParts.length);
    document.getElementById('listDetailOwnerActions').classList.toggle('hidden', !list.isOwner);
    // Like button: available to anyone who can see the list; needs a saved list.
    const likeBtn = document.getElementById('listDetailLikeBtn');
    likeBtn.classList.toggle('hidden', !list.id);
    likeBtn.classList.toggle('liked', !!list.liked_by_me);
    document.getElementById('listDetailLikeLabel').textContent = list.liked_by_me ? 'You liked this list' : 'Like this list?';
    document.getElementById('listDetailLikeCount').textContent = list.like_count ? list.like_count : '';
    document.getElementById('listDetailShareBtn').classList.toggle('hidden', !list.id); // nothing to share until it exists
    document.getElementById('listDetailCloneBtn').classList.toggle('hidden', !list.id);
    document.getElementById('listDetailCloneCount').textContent = list.clone_count ? `${list.clone_count} ${list.clone_count === 1 ? 'clone' : 'clones'}` : '';
    const visBtn = document.getElementById('listDetailVisibilityBtn');
    visBtn.classList.toggle('hidden', !list.id);
    visBtn.textContent = (list.visibility || 'private') === 'private' ? 'Make this list public' : 'Make this list private';
    // Hover-share popover: link (only once the list is public / link-shared) + Family.
    const linkInput = document.getElementById('listShareLinkInput');
    const linkable = list.id && ['public', 'link'].includes(list.visibility || 'private');
    linkInput.value = linkable ? `ivealready://list/${list.id}` : '';
    linkInput.placeholder = 'Make the list public for a link';
    document.getElementById('listShareCopyBtn').disabled = !linkable;
    renderListComments(list, editing);
    // "Add a title" only exists while actually editing — opening a list to
    // browse it shouldn't offer to change it.
    document.getElementById('listDetailAddForm').classList.toggle('hidden', !list.isOwner || !editing);
    document.getElementById('listDetailShareForm').classList.add('hidden');

    // Description + watched-stat + genre tags now live in their own row,
    // under the filter bar, instead of crowding the top header — hidden
    // entirely while editing, since the edit form has its own description field.
    document.getElementById('listDetailSummaryRow').classList.toggle('hidden', editing);

    const statEl = document.getElementById('listDetailWatchedStat');
    statEl.classList.toggle('hidden', list.items.length === 0);
    if (list.items.length) {
        const pct = Math.round((watchedCount / list.items.length) * 100);
        document.getElementById('listDetailWatchedStatValue').textContent = `${watchedCount} of ${list.items.length} (${pct}%)`;
    }

    const grid = document.getElementById('listDetailGrid');
    const manageBox = document.getElementById('listManageBox');
    // The bordered/background "box" treatment only makes sense around the
    // editable row-list (it reads as a form section there). While just
    // browsing, the grid should sit flush with the page's normal margins,
    // same as every other poster grid in the app — no extra frame.
    manageBox.classList.toggle('list-manage-box', editing);

    const filterBar = document.getElementById('listDetailFilterBar');
    filterBar.classList.toggle('hidden', editing || !list.items.length);

    if (!list.items.length) {
        grid.className = '';
        grid.innerHTML = `<p class="profile-tab-empty">No titles in this list yet.</p>`;
        return;
    }

    if (!editing) {
        // Browsing view — plain poster grid, same as everywhere else in the
        // app, with just a small watched checkmark; no drag/remove/note
        // controls, since those only make sense while actually editing. The
        // Decade/Genre/Sort filter bar above it is real and live-filters
        // this grid (see setupListDetailFilterBar/renderListDetailBrowsingGrid).
        setupListDetailFilterBar(list);
        renderListDetailBrowsingGrid(list);
        return;
    }

    // Toolbar sits above the row-list/grid — grid/list toggle + real Sort by
    // (on top of drag-to-reorder), plus Delete/View list/Save mirroring the
    // reference's action row.
    setupListManageToolbar(list);

    if (listManageGridView) {
        renderListManageGrid(list);
        return;
    }

    grid.className = ''; // row-list below manages its own layout, not a poster grid
    // Editing view — reorderable row list with drag handle, notes, remove.
    grid.innerHTML = `<div class="list-items-rows" id="listItemsRows"></div>`;
    const rowsEl = document.getElementById('listItemsRows');
    rowsEl.innerHTML = list.items.map((item, i) => {
        const posterUrl = item.poster_url || (item.poster_path ? `${imgSrc(item.poster_path)}` : '');
        return `
            <div class="list-item-row" draggable="true" data-media-id="${item.id}" data-tmdb-id="${item.tmdb_id}" data-media-type="${item.media_type}">
                <span class="list-item-drag-handle" title="Drag to reorder">&#8942;&#8942;</span>
                ${list.is_ranked ? `<span class="list-item-rank">${i + 1}</span>` : ''}
                <img class="list-item-poster" src="${posterUrl}" alt="" loading="lazy">
                <div class="list-item-title-col">
                    <div class="list-item-title">${escapeHtml(item.title)} <span class="list-item-year">${(item.release_date || '').slice(0, 4)}</span></div>
                </div>
                <div class="list-item-row-actions">
                    <button type="button" class="list-item-note-btn" data-edit-note="${item.id}">
                        &#9998; ${item.note ? escapeHtml(item.note.length > 60 ? `${item.note.slice(0, 60)}…` : item.note) : 'Add note'}
                    </button>
                    ${list.is_favorites ? `<button type="button" class="list-item-profile-btn${item.show_on_profile === false ? ' off' : ''}" data-profile-toggle="${item.id}" title="Show on my profile">${item.show_on_profile === false ? 'Hidden on profile' : 'On profile'}</button>` : ''}
                    ${item.status ? `<span class="list-item-watched-badge st-${item.status}">${escapeHtml(window.statusLabel(item.status, item.media_type))}</span>` : ''}
                    <button type="button" class="list-item-remove-row-btn" data-remove-item="${item.id}" title="Remove from list">
                        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6M14 11v6"/>
                            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    rowsEl.querySelectorAll('.list-item-row').forEach((row) => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('[data-remove-item]') || e.target.closest('[data-edit-note]') || e.target.closest('.list-item-drag-handle') || e.target.closest('[data-profile-toggle]')) return;
            openDetails(Number(row.dataset.tmdbId), row.dataset.mediaType);
        });
    });
    rowsEl.querySelectorAll('[data-edit-note]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openListNoteModal(Number(btn.dataset.editNote));
        });
    });
    rowsEl.querySelectorAll('[data-remove-item]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeListManageItem(Number(btn.dataset.removeItem));
        });
    });
    wireListItemsDragDrop(rowsEl);
    wireProfileToggles(rowsEl);
}

// Favorite Titles only: choose which favorites appear on the profile.
function wireProfileToggles(root) {
    root.querySelectorAll('[data-profile-toggle]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const mediaId = Number(btn.dataset.profileToggle);
            const item = currentListDetail.items.find((it) => it.id === mediaId);
            if (!item) return;
            const next = item.show_on_profile === false;
            try {
                await window.api.setListItemProfileVisible(currentListDetail.id, mediaId, next);
                item.show_on_profile = next;
                renderListDetail();
            } catch (err) { showToast(`Couldn't update: ${err.message}`, true); }
        });
    });
}

// Shared by both the row-list and the grid view below.
async function removeListManageItem(mediaId) {
    try {
        if (currentListDetail.is_favorites) {
            // Removing from Favorite Titles = un-hearting it (the database drops it from the list).
            await upsertEntryAndInvalidate(mediaId, { is_favorite: false });
        } else {
            await window.api.removeListItem(currentListDetail.id, mediaId);
        }
        currentListDetail.items = currentListDetail.items.filter((it) => it.id !== mediaId);
        renderListDetail();
    } catch (err) {
        showToast(`Couldn't remove: ${err.message}`, true);
    }
}

// Grid view of the editable list — same poster grid look as everywhere
// else, with a rank/watched badge and a small remove button overlay.
// Manual drag-to-reorder only applies to the row-list (dragging posters
// around a wrapping grid is fiddly) — switch to list view to reorder.
function renderListManageGrid(list) {
    const grid = document.getElementById('listDetailGrid');
    grid.className = 'poster-grid';
    grid.innerHTML = list.items.map((item, i) => {
        const posterUrl = item.poster_url || (item.poster_path ? `${imgSrc(item.poster_path)}` : '');
        return `
            <div class="poster-card list-grid-card" draggable="true" data-media-id="${item.id}" data-tmdb-id="${item.tmdb_id}" data-media-type="${item.media_type}">
                <div class="poster-img-wrap">
                    <img src="${posterUrl}" alt="" loading="lazy" draggable="false">
                    ${list.is_ranked ? `<span class="list-rank-badge">${i + 1}</span>` : ''}
                    ${statusFlag(item.status)}
                    ${list.is_favorites ? `<button type="button" class="list-grid-profile-btn${item.show_on_profile === false ? ' off' : ''}" data-profile-toggle="${item.id}" title="${item.show_on_profile === false ? 'Hidden on profile — click to show' : 'On profile — click to hide'}">${item.show_on_profile === false ? '&#9679;' : '&#10003;'}</button>` : ''}
                    <button type="button" class="list-item-remove-row-btn list-grid-remove-btn" data-remove-item="${item.id}" title="Remove from list">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6M14 11v6"/>
                            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                    </button>
                    <div class="film-card-overlay">
                        <div class="film-card-title">${escapeHtml(item.title)} <span class="list-item-year">${(item.release_date || '').slice(0, 4)}</span></div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    grid.querySelectorAll('.poster-card').forEach((card) => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-remove-item]') || e.target.closest('[data-profile-toggle]')) return;
            openDetails(Number(card.dataset.tmdbId), card.dataset.mediaType);
        });
    });
    grid.querySelectorAll('[data-remove-item]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeListManageItem(Number(btn.dataset.removeItem));
        });
    });
    wireProfileToggles(grid);
    wireListGridDragDrop(grid);
}

// Drag posters around the grid to reorder — the card under the cursor decides
// whether the dragged one lands before (left half) or after (right half) it.
let draggedGridCard = null;
function wireListGridDragDrop(grid) {
    grid.querySelectorAll('.list-grid-card').forEach((card) => {
        card.addEventListener('dragstart', (e) => {
            draggedGridCard = card;
            card.classList.add('dragging');
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.dataset.mediaId); }
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            draggedGridCard = null;
            persistGridOrder(grid);
        });
    });
    grid.addEventListener('dragover', (e) => {
        if (!draggedGridCard) return;
        e.preventDefault();
        const over = [...grid.querySelectorAll('.list-grid-card:not(.dragging)')].find((c) => {
            const r = c.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        });
        if (!over) return;
        const r = over.getBoundingClientRect();
        grid.insertBefore(draggedGridCard, e.clientX < r.left + r.width / 2 ? over : over.nextSibling);
    });
}
async function persistGridOrder(grid) {
    const mediaIds = [...grid.querySelectorAll('.list-grid-card')].map((c) => Number(c.dataset.mediaId));
    try {
        await window.api.reorderListItems(currentListDetail.id, mediaIds);
        const itemById = Object.fromEntries(currentListDetail.items.map((it) => [it.id, it]));
        currentListDetail.items = mediaIds.map((id) => itemById[id]).filter(Boolean);
        if (currentListDetail.is_ranked) renderListDetail();
    } catch (err) {
        showToast(`Couldn't save the new order: ${err.message}`, true);
    }
}

// ---- drag-to-reorder (vanilla HTML5 drag/drop — "closest row below the
// cursor" is the standard lightweight technique for this) ----
let draggedListRow = null;
function wireListItemsDragDrop(container) {
    container.querySelectorAll('.list-item-row').forEach((row) => {
        row.addEventListener('dragstart', () => {
            draggedListRow = row;
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            draggedListRow = null;
            persistListItemOrder(container);
        });
    });
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!draggedListRow) return;
        const afterRow = listRowAfterCursor(container, e.clientY);
        if (afterRow == null) container.appendChild(draggedListRow);
        else container.insertBefore(draggedListRow, afterRow);
    });
}
function listRowAfterCursor(container, y) {
    const rows = [...container.querySelectorAll('.list-item-row:not(.dragging)')];
    return rows.reduce((closest, row) => {
        const box = row.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset, element: row };
        return closest;
    }, { offset: -Infinity, element: null }).element;
}
async function persistListItemOrder(container) {
    const mediaIds = [...container.querySelectorAll('.list-item-row')].map((r) => Number(r.dataset.mediaId));
    try {
        await window.api.reorderListItems(currentListDetail.id, mediaIds);
        const itemById = Object.fromEntries(currentListDetail.items.map((it) => [it.id, it]));
        currentListDetail.items = mediaIds.map((id) => itemById[id]).filter(Boolean);
        if (currentListDetail.is_ranked) renderListDetail(); // refreshes the rank number badges
    } catch (err) {
        showToast(`Couldn't save the new order: ${err.message}`, true);
    }
}

// ---- per-item note modal ----
const listNoteModalEls = {
    modal: document.getElementById('listNoteModal'),
    poster: document.getElementById('listNoteModalPoster'),
    title: document.getElementById('listNoteModalTitle'),
    year: document.getElementById('listNoteModalYear'),
    textarea: document.getElementById('listNoteModalTextarea'),
    closeBtn: document.getElementById('listNoteModalClose'),
    cancelBtn: document.getElementById('listNoteModalCancel'),
    saveBtn: document.getElementById('listNoteModalSave'),
};
let listNoteModalMediaId = null;

function openListNoteModal(mediaId) {
    const item = currentListDetail.items.find((it) => it.id === mediaId);
    if (!item) return;
    listNoteModalMediaId = mediaId;
    const posterUrl = item.poster_url || (item.poster_path ? `${imgSrc(item.poster_path)}` : '');
    listNoteModalEls.poster.src = posterUrl;
    listNoteModalEls.title.textContent = item.title;
    listNoteModalEls.year.textContent = (item.release_date || '').slice(0, 4);
    listNoteModalEls.textarea.value = item.note || '';
    listNoteModalEls.modal.classList.remove('hidden');
    listNoteModalEls.textarea.focus();
}
function closeListNoteModal() {
    listNoteModalEls.modal.classList.add('hidden');
    listNoteModalMediaId = null;
}
listNoteModalEls.closeBtn.addEventListener('click', closeListNoteModal);
listNoteModalEls.cancelBtn.addEventListener('click', closeListNoteModal);
listNoteModalEls.modal.addEventListener('click', (e) => {
    if (e.target === listNoteModalEls.modal) closeListNoteModal(); // backdrop click
});
listNoteModalEls.saveBtn.addEventListener('click', async () => {
    if (!listNoteModalMediaId) return;
    const note = listNoteModalEls.textarea.value.trim();
    listNoteModalEls.saveBtn.disabled = true;
    try {
        await window.api.setListItemNote(currentListDetail.id, listNoteModalMediaId, note);
        const item = currentListDetail.items.find((it) => it.id === listNoteModalMediaId);
        if (item) item.note = note;
        closeListNoteModal();
        renderListDetail();
    } catch (err) {
        showToast(`Couldn't save note: ${err.message}`, true);
    } finally {
        listNoteModalEls.saveBtn.disabled = false;
    }
});

// ---- genre tag-input (type + Enter/comma to add a chip, click a chip to remove it) ----
let listEditGenres = [];
function renderListEditGenreTags() {
    document.getElementById('listEditGenreTags').innerHTML = listEditGenres.map((g, i) => `
        <span class="list-genre-tag" draggable="true" data-genre-index="${i}" title="Drag to reorder, click to remove">${escapeHtml(g)} &times;</span>
    `).join('');
    wireGenreTagDrag(document.getElementById('listEditGenreTags'));
    document.getElementById('listEditGenreTags').querySelectorAll('[data-genre-index]').forEach((tag) => {
        tag.addEventListener('click', () => {
            listEditGenres.splice(Number(tag.dataset.genreIndex), 1);
            renderListEditGenreTags();
        });
    });
}
let draggedGenreTag = null;
function wireGenreTagDrag(box) {
    box.querySelectorAll('.list-genre-tag').forEach((tag) => {
        tag.addEventListener('dragstart', (e) => {
            draggedGenreTag = tag; tag.classList.add('dragging');
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', tag.dataset.genreIndex); }
        });
        tag.addEventListener('dragend', () => {
            tag.classList.remove('dragging');
            draggedGenreTag = null;
            // Rebuild the array from the DOM order, then repaint so click-to-remove indexes are fresh.
            listEditGenres = [...box.querySelectorAll('.list-genre-tag')].map((t) => listEditGenres[Number(t.dataset.genreIndex)]);
            renderListEditGenreTags();
        });
    });
    box.ondragover = (e) => {
        if (!draggedGenreTag) return;
        e.preventDefault();
        const over = [...box.querySelectorAll('.list-genre-tag:not(.dragging)')].find((t) => {
            const r = t.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        });
        if (!over) return;
        const r = over.getBoundingClientRect();
        box.insertBefore(draggedGenreTag, e.clientX < r.left + r.width / 2 ? over : over.nextSibling);
    };
}
document.getElementById('listEditGenreInput').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const value = e.target.value.trim().replace(/,$/, '');
    if (value && !listEditGenres.includes(value)) {
        listEditGenres.push(value);
        renderListEditGenreTags();
    }
    e.target.value = '';
});

document.getElementById('listDetailLikeBtn').addEventListener('click', async () => {
    if (!currentListDetail?.id) return;
    const btn = document.getElementById('listDetailLikeBtn');
    btn.disabled = true;
    try {
        const { liked, count } = await window.api.toggleListLike(currentListDetail.id);
        currentListDetail.liked_by_me = liked;
        currentListDetail.like_count = count;
        renderListDetail();
    } catch (err) {
        showToast(`Couldn't update like: ${err.message}`, true);
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('listDetailEditBtn').addEventListener('click', () => {
    document.getElementById('listDetailShareForm').classList.add('hidden');
    const form = document.getElementById('listDetailEditForm');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) {
        document.getElementById('listEditNameInput').value = currentListDetail.name;
        document.getElementById('listEditDescInput').value = currentListDetail.description || '';
        document.getElementById('listEditRankedInput').checked = !!currentListDetail.is_ranked;
        listEditGenres = [...(currentListDetail.genres || [])];
        renderListEditGenreTags();
        document.getElementById('listEditGenreInput').value = '';
        listEditVisibility = currentListDetail.visibility || 'private';
        renderListEditVisibility();
    }
    renderListDetail(); // switches the items area between browsing grid and manageable row-list
});
document.getElementById('listEditCancelBtn').addEventListener('click', () => {
    if (!currentListDetail.id) {
        // Never actually created — nothing to leave hanging around, so
        // backing out just goes straight back to the list grid.
        closeListDetail();
        return;
    }
    document.getElementById('listDetailEditForm').classList.add('hidden');
    document.getElementById('listAddSearchResults').innerHTML = '';
    document.getElementById('listAddSearchInput').value = '';
    renderListDetail(); // back to the read-only list page
});
document.getElementById('listEditSaveBtn').addEventListener('click', async () => {
    const name = document.getElementById('listEditNameInput').value.trim();
    if (!name) {
        showToast('Give your list a name', true);
        return;
    }
    const description = document.getElementById('listEditDescInput').value.trim();
    const isRanked = document.getElementById('listEditRankedInput').checked;
    try {
        if (!currentListDetail.id) {
            const created = await window.api.createList(name, description, listEditGenres, isRanked, listEditVisibility);
            currentListDetail = { ...created, isOwner: true, items: currentListDetail.items || [] };
            showToast('List created');
        } else {
            await window.api.renameList(currentListDetail.id, name, description, listEditGenres, isRanked, listEditVisibility);
            currentListDetail.name = name;
            currentListDetail.description = description;
            currentListDetail.genres = [...listEditGenres];
            currentListDetail.is_ranked = isRanked;
            currentListDetail.visibility = listEditVisibility;
            showToast('List updated');
        }
        document.getElementById('listDetailEditForm').classList.add('hidden');
        renderListDetail();
    } catch (err) {
        showToast(`Couldn't save: ${err.message}`, true);
    }
});

document.getElementById('listDetailDeleteBtn').addEventListener('click', async () => {
    const ok = await showConfirm(`Delete "${currentListDetail.name}"? This can't be undone.`, { confirmLabel: 'Delete' });
    if (!ok) return;
    try {
        await window.api.deleteList(currentListDetail.id);
        showToast('List deleted');
        closeListDetail();
    } catch (err) {
        showToast(`Couldn't delete: ${err.message}`, true);
    }
});

// ---- sharing (scoped to family members — see shareList in supabase.js) ----
document.getElementById('listDetailShareBtn').addEventListener('click', async () => {
    document.getElementById('listDetailEditForm').classList.add('hidden');
    const form = document.getElementById('listDetailShareForm');
    form.classList.toggle('hidden');
    if (form.classList.contains('hidden')) return;

    const wrap = document.getElementById('listShareMembers');
    wrap.innerHTML = '<p class="profile-edit-hint">Loading family members…</p>';
    try {
        const [mine, shares] = await Promise.all([
            window.api.listMyFamily(),
            window.api.listListShares(currentListDetail.id),
        ]);
        const session = await window.api.getSession();
        const myId = session.user.id;
        const others = mine.members.filter((m) => m.user_id !== myId);
        const sharedIds = new Set(shares.map((s) => s.user_id));

        if (!others.length) {
            wrap.innerHTML = `<p class="profile-edit-hint">You're not in a family with anyone else yet — invite someone from the Account page first.</p>`;
            return;
        }
        wrap.innerHTML = others.map((m) => `
            <label class="account-checkbox-row">
                <input type="checkbox" data-share-user="${m.user_id}" ${sharedIds.has(m.user_id) ? 'checked' : ''}>
                ${escapeHtml(m.email)}
            </label>
        `).join('');
        wrap.querySelectorAll('[data-share-user]').forEach((checkbox) => {
            checkbox.addEventListener('change', async () => {
                const targetUserId = checkbox.dataset.shareUser;
                checkbox.disabled = true;
                try {
                    if (checkbox.checked) await window.api.shareList(currentListDetail.id, targetUserId);
                    else await window.api.unshareList(currentListDetail.id, targetUserId);
                } catch (err) {
                    checkbox.checked = !checkbox.checked; // revert
                    showToast(`Couldn't update sharing: ${err.message}`, true);
                } finally {
                    checkbox.disabled = false;
                }
            });
        });
    } catch (err) {
        wrap.innerHTML = `<p class="profile-edit-hint">Couldn't load family members: ${escapeHtml(err.message)}</p>`;
    }
});

// ---- add a title (live TMDB search, same debounce pattern as the navbar search) ----
document.getElementById('listAddBtn').addEventListener('click', () => {
    document.getElementById('listAddSearchInput').focus();
});

// ---- item-management toolbar actions: these mirror the Name/Description
// form's own Delete List / Cancel / Save — "View list" is the same action
// as Cancel (exit editing back to the read-only view). ----
document.getElementById('listManageDeleteBtn').addEventListener('click', () => {
    document.getElementById('listDetailDeleteBtn').click();
});
document.getElementById('listManageCancelBtn').addEventListener('click', () => {
    document.getElementById('listEditCancelBtn').click();
});
document.getElementById('listManageViewBtn').addEventListener('click', () => {
    document.getElementById('listEditCancelBtn').click();
});
document.getElementById('listManageSaveBtn').addEventListener('click', () => {
    document.getElementById('listEditSaveBtn').click();
});
let listAddSearchTimer = null;
document.getElementById('listAddSearchInput').addEventListener('input', (e) => {
    const query = e.target.value.trim();
    clearTimeout(listAddSearchTimer);
    const resultsEl = document.getElementById('listAddSearchResults');
    if (query.length < 2) {
        resultsEl.innerHTML = '';
        return;
    }
    listAddSearchTimer = setTimeout(async () => {
        try {
            const results = (await window.api.searchTmdb(query, 'multi')).filter((r) => r.media_type !== 'person');
            renderListAddResults(results);
        } catch (err) {
            resultsEl.innerHTML = `<p class="profile-edit-hint">${escapeHtml(err.message)}</p>`;
        }
    }, 350);
});

function renderListAddResults(results) {
    const resultsEl = document.getElementById('listAddSearchResults');
    if (!results.length) {
        resultsEl.innerHTML = `<p class="profile-edit-hint">No results</p>`;
        return;
    }
    const existingTmdbIds = new Set(currentListDetail.items.map((it) => `${it.media_type}:${it.tmdb_id}`));
    resultsEl.innerHTML = results.slice(0, 8).map((r) => {
        const already = existingTmdbIds.has(`${r.media_type}:${r.tmdb_id}`);
        const posterUrl = r.poster_path ? `${imgSrc(r.poster_path)}` : '';
        return `
            <div class="list-add-result-row ${already ? 'already-added' : ''}" data-tmdb-id="${r.tmdb_id}" data-media-type="${r.media_type}">
                <img src="${posterUrl}" alt="" loading="lazy">
                <div>
                    <div class="search-result-title">${escapeHtml(r.title)}</div>
                    <div class="search-result-meta">${(r.release_date || '').slice(0, 4)}${r.media_type === 'tv' ? ' · TV' : ''}</div>
                </div>
                <span class="list-add-result-action">${already ? 'Added' : '+ Add'}</span>
            </div>
        `;
    }).join('');
    resultsEl.querySelectorAll('.list-add-result-row:not(.already-added)').forEach((row) => {
        row.addEventListener('click', async () => {
            const tmdbId = Number(row.dataset.tmdbId);
            const mediaType = row.dataset.mediaType;
            row.classList.add('already-added');
            row.querySelector('.list-add-result-action').textContent = 'Adding…';
            try {
                const listId = await ensureListCreated();
                const details = await window.api.getDetails(tmdbId, mediaType);
                await window.api.addListItem(listId, details.mediaId);
                currentListDetail = await window.api.getList(listId);
                renderListDetail();
                row.querySelector('.list-add-result-action').textContent = 'Added';
                showToast(`Added to ${currentListDetail.name}`);
            } catch (err) {
                row.classList.remove('already-added');
                row.querySelector('.list-add-result-action').textContent = '+ Add';
                showToast(`Couldn't add: ${err.message}`, true);
            }
        });
    });
}

// ---------------- navbar search (global, live dropdown of results) ----------------

const navSearch = document.getElementById('navSearch');
document.getElementById('searchToggleBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    navSearch.classList.add('open');
    els.searchInput.focus();
});

els.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const query = els.searchInput.value.trim();
    if (query.length < 2) {
        els.searchResultsDropdown.classList.add('hidden');
        return;
    }
    searchDebounceTimer = setTimeout(() => runNavSearch(query), 350);
});

els.searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const query = els.searchInput.value.trim();
    if (query.length < 2) return;
    els.searchResultsDropdown.classList.add('hidden');
    navSearch.classList.remove('open');
    openSearchResults(query);
});

els.searchInput.addEventListener('focus', () => {
    if (els.searchInput.value.trim().length >= 2) els.searchResultsDropdown.classList.remove('hidden');
});

document.addEventListener('click', (e) => {
    if (!els.searchResultsDropdown.contains(e.target) && e.target !== els.searchInput) {
        els.searchResultsDropdown.classList.add('hidden');
    }
    // Collapse back to just the icon when clicking elsewhere — but only if
    // there's no in-progress query, so an active search never gets yanked
    // away mid-typing just because focus briefly moved.
    if (!navSearch.contains(e.target) && !els.searchInput.value.trim()) {
        navSearch.classList.remove('open');
    }
});

// "olivia 1951" → search "olivia" and keep only titles released in 1951.
// TMDB's own search has no year field for multi-search, so the year is
// peeled off a trailing 4-digit number and applied to the results here;
// a few pages are merged first so the right title isn't lost past page 1.
// A query that is ONLY a number ("1917") stays a plain title search.
function parseYearQuery(query) {
    const m = query.trim().match(/^(.*\S)\s+((?:18|19|20)\d{2})$/);
    return m ? { title: m[1], year: m[2] } : { title: query.trim(), year: null };
}
async function searchWithYear(query, page = 1) {
    const { title, year } = parseYearQuery(query);
    if (!year) return window.api.searchTmdbFull(query, 'multi', page);
    const first = await window.api.searchTmdbFull(title, 'multi', 1);
    const extra = [];
    for (let p = 2; p <= Math.min(first.totalPages || 1, 5); p++) extra.push(window.api.searchTmdbFull(title, 'multi', p).catch(() => ({ results: [] })));
    const rest = await Promise.all(extra);
    const all = [first, ...rest].flatMap((d) => d.results || [])
        .filter((r) => r.media_type !== 'person' && (r.release_date || '').slice(0, 4) === year);
    return { results: all, totalPages: 1, totalResults: all.length };
}

async function runNavSearch(query) {
    try {
        const results = parseYearQuery(query).year
            ? (await searchWithYear(query)).results
            : await window.api.searchTmdb(query, 'multi');
        renderSearchDropdown(results);
    } catch (err) {
        els.searchResultsDropdown.innerHTML = `<p class="empty-state" style="margin:0;padding:1.6rem;font-size:1.2rem;">${escapeHtml(err.message)}</p>`;
        els.searchResultsDropdown.classList.remove('hidden');
    }
}

function renderSearchDropdown(results) {
    if (results.length === 0) {
        els.searchResultsDropdown.innerHTML = '<p class="empty-state" style="margin:0;padding:1.6rem;font-size:1.2rem;">No results</p>';
        els.searchResultsDropdown.classList.remove('hidden');
        return;
    }
    const isBk = (r) => r.media_type === 'book' || r.media_type === 'game' || (r.media_type === 'person' && r.tmdb_id < 0);
    const shownRows = [...results.filter((r) => !isBk(r)).slice(0, 6), ...results.filter(isBk).slice(0, 3)].slice(0, 9);
    const rowsHtml = shownRows.map((r) => {
        const posterUrl = r.poster_path ? imgSrc(r.poster_path) : '';
        const isPerson = r.media_type === 'person';
        const meta = isPerson
            ? (r.department || 'Person')
            : `${(r.release_date || '').slice(0, 4)}${r.media_type === 'tv' ? ' · TV' : r.media_type === 'book' ? ' · Book' : r.media_type === 'game' ? ' · Videogame' : ''}`;
        return `
            <div class="search-result-row" data-tmdb-id="${r.tmdb_id}" data-media-type="${r.media_type}">
                <img src="${posterUrl}" alt="${escapeHtml(r.title)}" loading="lazy" class="${isPerson ? 'search-result-person-img' : ''}">
                <div>
                    <div class="search-result-title">${escapeHtml(r.title)}</div>
                    <div class="search-result-meta">${escapeHtml(meta)}</div>
                </div>
            </div>
        `;
    }).join('');
    const query = els.searchInput.value.trim();
    els.searchResultsDropdown.innerHTML = rowsHtml + `
        <button type="button" class="search-see-all-btn" id="searchSeeAllBtn">
            See all results for "${escapeHtml(query)}"
        </button>
    `;
    els.searchResultsDropdown.querySelectorAll('.search-result-row').forEach((row) => {
        row.addEventListener('click', () => {
            els.searchResultsDropdown.classList.add('hidden');
            els.searchInput.value = '';
            navSearch.classList.remove('open');
            if (row.dataset.mediaType === 'person') {
                openPerson(Number(row.dataset.tmdbId));
            } else {
                openDetails(Number(row.dataset.tmdbId), row.dataset.mediaType);
            }
        });
    });
    document.getElementById('searchSeeAllBtn').addEventListener('click', () => {
        els.searchResultsDropdown.classList.add('hidden');
        navSearch.classList.remove('open');
        openSearchResults(query);
    });
    els.searchResultsDropdown.classList.remove('hidden');
}

// ---------------- dashboard (Home/Watched/Read/Played) ----------------

let queueCache = [];
let plannedCache = [];
let seriesPlannedCache = [];

// Academy/BAFTA definition of a "short" — 40 minutes or under, credits
// included. Runtime comes from TMDB (cached on the media row); anything
// with no runtime on file defaults to being treated as a regular feature
// rather than silently getting misclassified as a short.
const SHORT_FILM_MAX_RUNTIME = 40;
function isShortFilm(e) {
    return e.media_type === 'movie' && typeof e.runtime === 'number' && e.runtime > 0 && e.runtime <= SHORT_FILM_MAX_RUNTIME;
}

// One shared sort setting for the whole app (Steam-style: pick a sort once,
// it applies everywhere and survives restarts) rather than a separate
// choice per row. Persisted to localStorage — this is the renderer process
// (a real Chromium window), so unlike the main process it actually has one.
const SORT_PREFS_KEY = 'iveAlready.sortPrefs';
const SORT_DEFAULT_DIRECTION = { last_watched: false, release_date: false, rating: false, alphabetical: true }; // true = ascending
let sortCriterion = 'last_watched';
let sortAscending = false;

(function loadSortPrefs() {
    try {
        const saved = JSON.parse(localStorage.getItem(SORT_PREFS_KEY) || 'null');
        if (saved && typeof saved.criterion === 'string' && typeof saved.ascending === 'boolean') {
            sortCriterion = saved.criterion;
            sortAscending = saved.ascending;
        }
    } catch { /* corrupt or unavailable storage — just use the defaults above */ }
})();

function saveSortPrefs() {
    try {
        localStorage.setItem(SORT_PREFS_KEY, JSON.stringify({ criterion: sortCriterion, ascending: sortAscending }));
    } catch { /* storage unavailable — sorting still works, it just won't persist */ }
}

function toggleSortDirection() {
    sortAscending = !sortAscending;
    saveSortPrefs();
    renderSortControls();
}

// Your Next Watch / Series to Watch keep only the direction arrow — no
// dropdown, since they're always sorted by release date now. Watched
// Films / Watched Series keep the full dropdown.
const ALL_SORT_DIR_IDS = [];

// Rebuilds every row's direction-arrow button, then re-renders the Next
// Watch rows against the current sort direction. Called once on load and
// again every time that direction is toggled.
function renderSortControls() {
    ALL_SORT_DIR_IDS.forEach((dirId) => {
        const btn = document.getElementById(dirId);
        btn.classList.toggle('ascending', sortAscending);
        btn.title = sortAscending ? 'Ascending (click for descending)' : 'Descending (click for ascending)';
    });

    renderNextWatchRow(plannedCache);
    renderSeriesNextRow(seriesPlannedCache);
    // Finished/Short Films/Series rows (what's already watched) used to
    // render here too, but that content now lives only on the profile's
    // Watched tab — these dashboard pages are for what's still ahead of
    // you, not a second copy of what's already done.
}

// The only thing that ever varies between sections' listEntries() calls is
// mediaType (status is always passed as null) — so instead of a fresh
// Supabase round trip on every section switch, fetch the whole library
// once, cache it for the session, and filter by mediaType client-side.
// Invalidated (see invalidateEntriesCache below) by anything that actually
// writes — a status change, a delete, an episode toggle, or the background
// new-episodes check.
let entriesCache = null;
let entriesCacheDirty = true;
let entriesCacheVersion = 0; // bumped only on an actual refetch, not a cache hit
async function getAllEntriesCached() {
    if (entriesCacheDirty || entriesCache === null) {
        entriesCache = await window.api.listEntries({ status: null, mediaType: null });
        entriesCacheDirty = false;
        entriesCacheVersion++;
    }
    return entriesCache;
}
function invalidateEntriesCache() {
    entriesCacheDirty = true;
}

// Thin wrappers so every write path invalidates the cache in one place,
// instead of relying on each of the many call sites to remember to.
async function upsertEntryAndInvalidate(mediaId, fields) {
    const entry = await window.api.upsertEntry(mediaId, fields);
    invalidateEntriesCache();
    return entry;
}
async function deleteEntryAndInvalidate(entryId) {
    await window.api.deleteEntry(entryId);
    invalidateEntriesCache();
}
async function toggleEpisodeWatchedAndInvalidate(entryId, episodeId, watched) {
    const ids = await window.api.toggleEpisodeWatched(entryId, episodeId, watched);
    invalidateEntriesCache(); // episode counts feed the Continue Watching progress bars
    return ids;
}

let dashLoadSeq = 0;
let dashAutoRetried = false;
async function loadDashboard() {
    const requestedSection = currentSection;
    const mySeq = ++dashLoadSeq;
    // Blank every row first so nothing from the previous section can linger on screen.
    ['heroBanner', 'queueSection', 'nextWatchSection', 'seriesNextSection', 'continueWatchingSection', 'continueReadingSection', 'continuePlayingSection']
        .forEach((id) => document.getElementById(id)?.classList.add('hidden'));
    const cfg = SECTIONS[currentSection];
    els.dashboardView.classList.add('hidden');
    els.sectionNotice.classList.add('hidden');
    setCatalogLoading(true);
    let all;
    try {
        all = await getAllEntriesCached();
    } catch (err) {
        // Don't leave the page half-drawn (or the spinner stuck) if the library can't be fetched.
        console.error('Failed to load library:', err);
        if (mySeq === dashLoadSeq) {
            els.sectionNotice.textContent = `Couldn't load your library: ${err.message || err}. Click a tab to try again.`;
            els.sectionNotice.classList.remove('hidden');
        }
        all = null;
    } finally {
        if (mySeq === dashLoadSeq) setCatalogLoading(false);
    }
    if (all === null) return;
    // If the user navigated to a different section (e.g. Lists) while this
    // was still loading, applying its result now would incorrectly show
    // the dashboard again on top of wherever they actually are.
    if (mySeq !== dashLoadSeq || currentSection !== requestedSection) return;
    allEntries = cfg.mediaTypes ? all.filter((e) => cfg.mediaTypes.includes(e.media_type)) : all;

    if (allEntries.length === 0) {
        els.dashboardView.classList.add('hidden');
        els.sectionNotice.textContent = cfg.emptyText;
        els.sectionNotice.classList.remove('hidden');
        return;
    }
    els.sectionNotice.classList.add('hidden');
    els.dashboardView.classList.remove('hidden');
    resetViewAllToggles();

    const planned = allEntries.filter((e) => e.status === 'planned');
    // Series get their own "Series to Watch" row, separate from movies —
    // "Your Next Watch" covers everything else planned (movies now; books/
    // games once those are wired up, since neither exists yet to split out).
    // Titles the wheel (or the detail popup) put in the queue live in their
    // own "Up Next" row, oldest-queued first, and leave the two pools below.
    queueCache = planned.filter((e) => e.queued_at)
        .sort((a, b) => new Date(a.queued_at) - new Date(b.queued_at));
    const unqueued = planned.filter((e) => !e.queued_at);
    plannedCache = unqueued.filter((e) => e.media_type !== 'tv');
    seriesPlannedCache = unqueued.filter((e) => e.media_type === 'tv');
    // Home shows only what's in progress (Watching / Reading / Playing) plus the Up Next queue;
    // the "Your Next ..." plan rows live on the Watch / Read / Play pages.
    const onHome = currentSection === 'home';
    const inProg = (t) => allEntries.filter((e) => e.status === 'in_progress' && e.media_type === t);
    if (onHome) { plannedCache = []; seriesPlannedCache = []; }

    // One failing row must never leave the whole page blank.
    const safe = async (label, fn) => { try { await fn(); } catch (err) { console.error(`dashboard: ${label} failed`, err); } };
    await safe('hero', () => renderHeroBanner(queueCache[0] || planned[0] || null));
    await safe('queue', () => renderQueueRow(queueCache));
    await safe('plans', () => renderSortControls());
    await Promise.all([
        safe('continue tv', () => renderContinueWatchingRow(inProg('tv'), 'tv', mySeq)),
        safe('continue books', () => renderContinueWatchingRow(inProg('book'), 'book', mySeq)),
        safe('continue games', () => renderContinueWatchingRow(inProg('game'), 'game', mySeq)),
    ]);
    if (mySeq !== dashLoadSeq) return; // same guard — this row render also awaits
    const anyRow = ['heroBanner', 'queueSection', 'nextWatchSection', 'seriesNextSection', 'continueWatchingSection', 'continueReadingSection', 'continuePlayingSection']
        .some((id) => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); });
    if (!anyRow) {
        // Nothing drew. A stale library snapshot is the usual cause, so refetch once before giving up.
        if (!dashAutoRetried) {
            dashAutoRetried = true;
            invalidateEntriesCache();
            return loadDashboard();
        }
        els.dashboardView.classList.add('hidden');
        els.sectionNotice.textContent = onHome
            ? 'Nothing in progress right now. Start something from Play, Read or Watch, or add titles to Up Next.'
            : 'Nothing planned or in progress here. Add something from search, or click this tab again to reload.';
        els.sectionNotice.classList.remove('hidden');
        return;
    }
    dashAutoRetried = false;
    applyLibrarySearchFilter(); // re-apply whatever's currently typed, since every row above just got freshly rendered
}

// Filters everything on the current dashboard page by title as you type —
// separate from the magnifying-glass TMDB search (that one's for finding
// new things to add; this one's for finding something already in your
// library without scrolling through every row). Hides individual cards
// that don't match, and hides a whole row/section if nothing in it matches,
// rather than leaving an empty-looking header on screen.
function applyLibrarySearchFilter() {
    const query = els.librarySearchInput.value.trim().toLowerCase();
    document.querySelectorAll('#dashboardView .poster-row-section').forEach((section) => {
        const cards = section.querySelectorAll('.poster-card');
        if (cards.length === 0) return; // already legitimately empty/hidden — leave as-is
        let anyVisible = false;
        cards.forEach((card) => {
            const title = (card.querySelector('img')?.alt || '').toLowerCase();
            const match = !query || title.includes(query);
            card.classList.toggle('search-hidden', !match);
            if (match) anyVisible = true;
        });
        section.classList.toggle('search-no-match', query.length > 0 && !anyVisible);
    });
}
els.librarySearchInput.addEventListener('input', applyLibrarySearchFilter);

// "View All" turns a horizontally-scrolling row into a wrapped grid showing
// everything at once — same items, same renderPosterGrid() markup, just a
// different container class, so no re-fetch or re-render logic is needed.
function resetViewAllToggles() {
    document.querySelectorAll('#dashboardView .view-all-btn[data-target]').forEach((btn) => {
        const row = document.getElementById(btn.dataset.target);
        if (!row) return;
        row.classList.remove('poster-grid');
        row.classList.add('poster-row');
        btn.textContent = 'View All';
    });
}

document.querySelectorAll('#dashboardView .view-all-btn[data-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
        const row = document.getElementById(btn.dataset.target);
        if (!row) return;
        const isGrid = row.classList.toggle('poster-grid');
        row.classList.toggle('poster-row', !isGrid);
        btn.textContent = isGrid ? 'Show Less' : 'View All';
    });
});

// Spotlights one plan-to-watch title (the most recently added) as a
// full-width backdrop banner at the top of the page — Netflix-style "here's
// something to watch" rather than dropping straight into a flat list.
function renderHeroBanner(item) {
    if (!item) { els.heroBanner.classList.add('hidden'); els.heroBanner.innerHTML = ''; return; }
    els.heroBanner.classList.remove('hidden');
    const backdrop = item.backdrop_url || item.poster_url || '';
    const genres = (() => { try { return JSON.parse(item.genres || '[]'); } catch { return []; } })();
    els.heroBanner.style.backgroundImage = backdrop ? `url('${backdrop}')` : 'none';
    els.heroBanner.innerHTML = `
        <div class="hero-banner-content">
            <div class="hero-banner-label">${sectionWords().hero}</div>
            <h1 class="hero-banner-title">${escapeHtml(item.title)}</h1>
            <div class="hero-banner-meta">
                ${(item.release_date || '').slice(0, 4)}
                ${typeof item.imdb_rating === 'number' ? ` · IMDb ★ ${item.imdb_rating.toFixed(1)}` : ''}
                ${typeof item.rt_tomatometer === 'number' ? ` · 🍅 ${item.rt_tomatometer}%` : ''}
                ${genres.length ? ` · ${genres.slice(0, 3).join(', ')}` : ''}
            </div>
            <p class="hero-banner-overview">${escapeHtml(item.overview || '')}</p>
            <button class="hero-banner-btn" data-tmdb-id="${item.tmdb_id}" data-media-type="${item.media_type}">View Details</button>
        </div>
    `;
    els.heroBanner.querySelector('.hero-banner-btn').addEventListener('click', () => openDetails(item.tmdb_id, item.media_type));
}

function renderQueueRow(items) {
    els.queueSection.classList.toggle('hidden', items.length === 0);
    if (items.length === 0) return;
    els.queueTitle.textContent = `Up Next (${items.length})`;
    // Queue order, not release order — first one in is first one up.
    renderPosterGrid(els.queueRow, items, 'queue');
    wireQueueDragDrop(items);
}

// Drag a queued card to a new spot. The order is stored in queued_at
// (oldest = first up), so a drop just re-stamps those times in the new order.
function wireQueueDragDrop(items) {
    const row = els.queueRow;
    let dragged = null;
    row.querySelectorAll('.poster-card').forEach((card) => {
        card.draggable = true;
        card.querySelectorAll('img').forEach((img) => img.setAttribute('draggable', 'false')); // otherwise the browser drags the bare image
        card.addEventListener('dragstart', (e) => {
            dragged = card;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', card.dataset.tmdbId);
        });
        card.addEventListener('dragend', async () => {
            card.classList.remove('dragging');
            dragged = null;
            const order = [...row.querySelectorAll('.poster-card')].map((c) =>
                items.find((it) => String(it.tmdb_id) === c.dataset.tmdbId && it.media_type === c.dataset.mediaType));
            if (order.some((it) => !it) || order.every((it, i) => it === items[i])) return;
            const base = Math.min(...items.map((it) => new Date(it.queued_at).getTime()));
            const stamps = order.map((_, i) => new Date(base + i * 1000).toISOString());
            try {
                await Promise.all(order.map((it, i) => window.api.upsertEntry(it.media_id, { queued_at: stamps[i] })));
                // The row on screen is already in the new order — just update the data
                // behind it in place instead of reloading (and re-flashing) the whole page.
                order.forEach((it, i) => { it.queued_at = stamps[i]; });
                items.splice(0, items.length, ...order);
                queueCache = items;
                invalidateEntriesCache();
            } catch (err) {
                showToast(`Couldn't save the new order: ${err.message}`, true);
                renderQueueRow(queueCache); // put the row back as it was
            }
        });
    });
    row.ondrop = (e) => e.preventDefault();
    row.ondragover = (e) => { // property, not addEventListener: this is wired on every render
        if (!dragged) return;
        e.preventDefault();
        const others = [...row.querySelectorAll('.poster-card:not(.dragging)')];
        // The card under the cursor decides: left half = before it, right half = after.
        const over = others.find((c) => {
            const r = c.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        });
        if (!over) return;
        const r = over.getBoundingClientRect();
        row.insertBefore(dragged, e.clientX < r.left + r.width / 2 ? over : over.nextSibling);
    };
}

// Your Next Watch / Series to Watch: same filter bar as the profile's
// Watched tab (search, decade, genre, sort + direction), minus "My Rating"
// (nothing's rated yet) and with "Last Added" in place of "Last Watched".
const planRowState = {
    nextWatch: { search: '', decade: null, genre: null, sort: 'last_added', ascending: false, items: [] },
    seriesNext: { search: '', decade: null, genre: null, sort: 'last_added', ascending: false, items: [] },
};
function addedKey(e) {
    const t = new Date(e.created_at || e.updated_at || 0).getTime() || 0;
    return t * 1e6 + (Number(e.id) || 0) % 1e6;
}
function paintPlanRow(prefix, rowEl, sortOptions) {
    const st = planRowState[prefix];
    let list = st.items;
    if (st.search) { const q = st.search.toLowerCase(); list = list.filter((e) => (e.title || '').toLowerCase().includes(q)); }
    if (st.decade != null) list = list.filter((e) => decadeOf(e.release_date) === st.decade);
    if (st.genre) list = list.filter((e) => { try { return JSON.parse(e.genres || '[]').includes(st.genre); } catch { return false; } });
    const sorted = [...list];
    switch (st.sort) {
        case 'alphabetical': sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'release_date': sorted.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '')); break;
        case 'platform_rating': sorted.sort((a, b) => (a.imdb_rating ?? -1) - (b.imdb_rating ?? -1)); break;
        case 'runtime': sorted.sort((a, b) => (a.runtime ?? -1) - (b.runtime ?? -1)); break;
        case 'seasons': sorted.sort((a, b) => (a.number_of_seasons ?? -1) - (b.number_of_seasons ?? -1)); break;
        default: sorted.sort((a, b) => addedKey(a) - addedKey(b)); break;
    }
    if (!st.ascending) sorted.reverse();
    renderPosterGrid(rowEl, sorted, 'release_date');
    applyLibrarySearchFilter();
}
function setupPlanRowControls(prefix, rowEl, sortOptions) {
    const st = planRowState[prefix];
    applyViewPrefs(prefix, st);
    const repaint = () => paintPlanRow(prefix, rowEl, sortOptions);
    const genres = [...new Set(st.items.flatMap((e) => { try { return JSON.parse(e.genres || '[]'); } catch { return []; } }))].sort();
    if (st.genre && !genres.includes(st.genre)) st.genre = null;
    const input = document.getElementById(`${prefix}Search`);
    input.value = st.search;
    input.oninput = (e) => { st.search = e.target.value.trim(); repaint(); };
    createCustomSelect({
        container: document.getElementById(`${prefix}Decade`),
        options: [{ value: '', label: 'Any Decade' }, ...Array.from({ length: 14 }, (_, i) => {
            const d = 2020 - i * 10;
            return { value: String(d), label: `${d}s` };
        })],
        value: st.decade != null ? String(st.decade) : '',
        onChange: (v) => { st.decade = v ? Number(v) : null; repaint(); },
    });
    createCustomSelect({
        container: document.getElementById(`${prefix}Genre`),
        options: [{ value: '', label: 'Any Genre' }, ...genres.map((g) => ({ value: g, label: g }))],
        value: st.genre || '',
        onChange: (v) => { st.genre = v || null; repaint(); },
    });
    createCustomSelect({
        container: document.getElementById(`${prefix}Sort`),
        options: sortOptions,
        value: st.sort,
        onChange: (v) => { st.sort = v; saveViewPrefs(prefix, st); repaint(); },
    });
    const dirBtn = document.getElementById(`${prefix}SortDir`);
    const syncDir = () => {
        dirBtn.classList.toggle('ascending', st.ascending);
        dirBtn.title = st.ascending ? 'Ascending (click for descending)' : 'Descending (click for ascending)';
    };
    syncDir();
    dirBtn.onclick = () => { st.ascending = !st.ascending; saveViewPrefs(prefix, st); syncDir(); repaint(); };
    repaint();
}
const NEXT_WATCH_SORTS = [
    { value: 'last_added', label: 'Last Added' },
    { value: 'alphabetical', label: 'Alphabetical' },
    { value: 'release_date', label: 'Release Date' },
    { value: 'platform_rating', label: 'Platform Rating' },
    { value: 'runtime', label: 'Film Length' },
];
const SERIES_NEXT_SORTS = [
    { value: 'last_added', label: 'Last Added' },
    { value: 'alphabetical', label: 'Alphabetical' },
    { value: 'release_date', label: 'Release Date' },
    { value: 'platform_rating', label: 'Platform Rating' },
    { value: 'seasons', label: 'Seasons' },
];

function renderNextWatchRow(items) {
    els.nextWatchSection.classList.toggle('hidden', items.length === 0);
    if (items.length === 0) return;
    els.nextWatchTitle.textContent = `${sectionWords().next} (${items.length})`;
    planRowState.nextWatch.items = items;
    setupPlanRowControls('nextWatch', els.nextWatchRow, NEXT_WATCH_SORTS);
}

function renderSeriesNextRow(items) {
    els.seriesNextSection.classList.toggle('hidden', items.length === 0);
    if (items.length === 0) return;
    els.seriesNextTitle.textContent = `Series to Watch (${items.length})`;
    planRowState.seriesNext.items = items;
    setupPlanRowControls('seriesNext', els.seriesNextRow, SERIES_NEXT_SORTS);
}

// Continue Watching needs per-show episode progress, which listEntries
// doesn't return (it's a separate table) — one bulk call for every
// in-progress show, then render each with a progress bar instead of the
// usual bottom date badge.
// Cached the same way as getAllEntriesCached above — keyed on which entries
// are actually in Continue Watching plus the entries-cache version, so a
// pure section switch (same shows, nothing written since) reuses this
// instead of redoing all 3 round trips, but any real change (an episode
// toggled, a show added/removed from Continue Watching) still gets a
// fresh fetch, since either the version or the key will have moved.
let continueWatchingAuxCache = null;

async function renderContinueWatchingRow(items, kind = 'tv', seq = dashLoadSeq) {
    const refs = kind === 'tv'
        ? { sec: els.continueWatchingSection, title: els.continueWatchingTitle, row: els.continueWatchingRow, word: 'Continue Watching' }
        : kind === 'book'
            ? { sec: document.getElementById('continueReadingSection'), title: document.getElementById('continueReadingTitle'), row: document.getElementById('continueReadingRow'), word: 'Continue Reading' }
            : { sec: document.getElementById('continuePlayingSection'), title: document.getElementById('continuePlayingTitle'), row: document.getElementById('continuePlayingRow'), word: 'Continue Playing' };
    refs.sec.classList.toggle('hidden', items.length === 0);
    if (items.length === 0) { refs.row.innerHTML = ''; return; }
    refs.title.textContent = `${refs.word} (${items.length})`;

    const cacheKey = `${entriesCacheVersion}:${items.map((e) => e.id).sort((a, b) => a - b).join(',')}`;
    let counts, lastSeasons, seasonPosters;
    if (continueWatchingAuxCache && continueWatchingAuxCache.key === cacheKey) {
        ({ counts, lastSeasons, seasonPosters } = continueWatchingAuxCache);
    } else if (kind !== 'tv') {
        counts = {}; lastSeasons = {}; seasonPosters = {};
    } else {
        counts = {};
        lastSeasons = {};
        try {
            [counts, lastSeasons] = await Promise.all([
                window.api.getEpisodeProgress(items.map((e) => e.id)),
                window.api.getLastWatchedSeasons(items.map((e) => e.id)),
            ]);
        } catch (err) {
            console.error('Failed to load episode progress:', err);
        }

        // Show the poster for the season you're actually on, not just the
        // show's generic poster — same idea as the "Season 3" label itself.
        seasonPosters = {};
        const seasonPairs = items
            .filter((item) => lastSeasons[item.id] != null)
            .map((item) => ({ mediaId: item.media_id, seasonNumber: lastSeasons[item.id] }));
        if (seasonPairs.length > 0) {
            try {
                seasonPosters = await window.api.getSeasonPosters(seasonPairs);
            } catch (err) {
                console.error('Failed to load season posters:', err);
            }
        }
        continueWatchingAuxCache = { key: cacheKey, counts, lastSeasons, seasonPosters };
    }

    let gameProg = {};
    if (kind === 'game') {
        try { gameProg = await window.api.getGameProgress(items.map((e) => ({ mediaId: e.media_id, gameId: e.tmdb_id }))) || {}; }
        catch (err) { console.error('Failed to load achievement progress:', err); }
    }
    if (seq !== dashLoadSeq) return; // a newer page load took over while this was fetching
    const pctOf = (it) => {
        const t = it.number_of_episodes || 0;
        return t > 0 ? (counts[it.id] || 0) / t : 0;
    };
    items = [...items].sort((a, b) => pctOf(b) - pctOf(a));

    refs.row.innerHTML = items.map((item) => {
        const season = lastSeasons[item.id];
        const seasonPosterUrl = season != null ? seasonPosters[`${item.media_id}:${season}`] : null;
        const posterUrl = seasonPosterUrl || item.poster_url || (item.poster_path ? `${imgSrc(item.poster_path)}` : '');
        const watched = counts[item.id] || 0;
        const total = item.number_of_episodes || 0;
        const pct = total > 0 ? Math.min(100, Math.round((watched / total) * 100)) : 0;
        return `
            <div class="poster-card" data-tmdb-id="${item.tmdb_id}" data-media-type="${item.media_type}">
                <div class="poster-img-wrap">
                    <img src="${posterUrl}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.opacity=0.3">
                </div>
                ${item.media_type === 'tv' ? `<div class="continue-watching-progress">
                    <div class="continue-watching-bar"><div class="continue-watching-fill" style="width:${pct}%"></div></div>
                    <div class="continue-watching-label">${total ? `${watched} of ${total} episodes` : `${watched} episodes watched`}</div>
                </div>` : `<div class="continue-watching-progress">${item.media_type === 'game' && gameProg[item.media_id]?.total ? `<div class="continue-watching-bar"><div class="continue-watching-fill" style="width:${Math.round(gameProg[item.media_id].done / gameProg[item.media_id].total * 100)}%"></div></div>` : ''}${item.media_type === 'book' && item.current_page ? `<div class="continue-watching-bar"><div class="continue-watching-fill" style="width:${item.page_total ? Math.min(100, Math.round(item.current_page / item.page_total * 100)) : 0}%"></div></div>` : ''}<div class="continue-watching-label">${item.media_type === 'book' ? (item.current_page ? `Page ${item.current_page}${item.page_total ? ` of ${item.page_total}` : ''}` : 'Reading') : (gameProg[item.media_id]?.total ? `${gameProg[item.media_id].done} of ${gameProg[item.media_id].total} achievements` : 'Playing')}</div></div>`}
            </div>
        `;
    }).join('');
    refs.row.querySelectorAll('.poster-card').forEach((card) => {
        card.addEventListener('click', () => openDetails(Number(card.dataset.tmdbId), card.dataset.mediaType));
    });
}

// For "Last Watched/Read/Played": updated_at gets stamped the moment an
// entry is created too, so a freshly-added "Plan to Watch" would otherwise
// outrank something genuinely watched days ago. date_finished/date_started
// reflect real watch activity — fall back to updated_at only when neither
// is set (an untouched item with no dates yet).
function watchActivityKey(entry) {
    // Falls back to the rewatch date too, same reasoning as the poster
    // badge above — a real date on the entry should outrank the generic
    // updated_at fallback, whichever specific date field it came from.
    const hasWatchDate = Boolean(entry.date_finished || entry.date_started || entry.date_rewatched);
    // quick_saved (Roulette's "Mark Watched") is a deliberate "yes, done,
    // don't know when" — distinct from an old entry that just happens to
    // have no date. It always sorts as the most recent thing, ahead of
    // even a dated entry, until a real date gets added (see the date-input
    // onChange handlers, which clear this flag the moment that happens).
    if (entry.quick_saved && !hasWatchDate) return 2e15;
    const raw = entry.date_finished || entry.date_started || entry.date_rewatched || entry.updated_at;
    const time = raw ? new Date(raw).getTime() : 0;
    // date_started/date_finished are date-only (parsed as UTC midnight) while
    // updated_at is a precise timestamp — on the same calendar day, a
    // date-only value would otherwise look "earlier" than a timestamped one
    // purely from time-of-day. A large offset guarantees anything with a
    // real watch date always outranks anything with only updated_at,
    // regardless of that quirk, while still sorting correctly within each group.
    return (hasWatchDate ? 1e15 : 0) + time;
}

// Each comparator sorts ascending (A-Z / oldest-first / least-recently-
// watched-first) by default — sortAscending=false just reverses that,
// same idea as Pokémon GO's increasing/decreasing toggle.
//
// date_finished/date_started only have day-level precision, so two things
// watched the same day tie exactly on watchActivityKey. Breaking that tie
// by updated_at (which IS a precise timestamp) reflects the order they were
// actually logged in — a reasonable stand-in for which one was watched
// first that day. Every other criterion falls back to this same "last
// watched" ordering for its own ties too, rather than leaving tied items in
// whatever arbitrary order the database happened to return them in.
function lastWatchedTiebreak(a, b) {
    const diff = watchActivityKey(a) - watchActivityKey(b);
    if (diff !== 0) return diff;
    return new Date(a.updated_at || 0).getTime() - new Date(b.updated_at || 0).getTime();
}

function sortEntries(items, criterion) {
    const sorted = [...items];
    switch (criterion) {
        case 'alphabetical':
            sorted.sort((a, b) => a.title.localeCompare(b.title) || lastWatchedTiebreak(a, b));
            break;
        case 'release_date':
            sorted.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '') || lastWatchedTiebreak(a, b));
            break;
        case 'rating':
            // Unrated items sort as lowest (-1); favorites sort as highest
            // (11, beyond a perfect 10) — a favorite isn't "no rating", it's
            // rated beyond the 5-star scale entirely.
            sorted.sort((a, b) => {
                const av = (a.rating ?? -1) * 2 + (a.is_favorite ? 1 : 0);
                const bv = (b.rating ?? -1) * 2 + (b.is_favorite ? 1 : 0);
                return (av - bv) || lastWatchedTiebreak(a, b);
            });
            break;
        case 'last_watched':
        default:
            sorted.sort(lastWatchedTiebreak);
            break;
    }
    if (!sortAscending) sorted.reverse();
    return sorted;
}

function renderPosterGrid(container, items, sortCriterion) {
    if (items.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = items.map((item) => {
        const posterUrl = item.poster_url || (item.poster_path ? `${imgSrc(item.poster_path)}` : '');
        const title = escapeHtml(item.title);
        // Steam-style overlay bar across the bottom of the poster, colored
        // by status (same palette as the detail-page status pills) instead
        // of a separate badge above the poster — this is now the only
        // status/date indicator on the card.
        const badgeText = dateBadgeFor(item, sortCriterion);
        const hasRealDate = Boolean(item.date_finished || item.date_started || item.date_rewatched);
        const badgeClass = (item.quick_saved && !hasRealDate) || (item.queued_at && item.status === 'planned' && item.queued_via !== 'manual')
            ? 'rate-quicksaved' // Roulette's "Mark Watched" — no date yet, stands out as its own color until one's added
            : sortCriterion === 'rating' ? ratingBadgeClass(item) : `status-pill--${item.status || 'planned'}`;
        const dateBadge = badgeText ? `<div class="poster-date-badge ${badgeClass}">${badgeText}</div>` : '';
        return `
            <div class="poster-card" data-tmdb-id="${item.tmdb_id}" data-media-type="${item.media_type}">
                <div class="poster-img-wrap">
                    <img src="${posterUrl}" alt="${title}" loading="lazy" onerror="this.style.opacity=0.3">
                    ${dateBadge}
                    ${sortCriterion === 'queue' ? '<button type="button" class="queue-remove-btn" title="Remove from queue">&#10005;</button>' : ''}
                    <div class="film-card-overlay">
                        <div class="film-card-title">${title}${item.release_date ? ` (${item.release_date.slice(0, 4)})` : ''}</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    container.querySelectorAll('.poster-card').forEach((card) => {
        card.addEventListener('click', () => openDetails(Number(card.dataset.tmdbId), card.dataset.mediaType));
    });
    if (sortCriterion === 'queue') {
        container.querySelectorAll('.queue-remove-btn').forEach((btn, i) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await upsertEntryAndInvalidate(items[i].media_id, { queued_at: null });
                    showToast(`Removed "${items[i].title}" from your queue`);
                    loadDashboard();
                } catch (err) { showToast(`Couldn't remove: ${err.message}`, true); }
            });
        });
    }
}

async function addToQueue(item, via = 'wheel') {
    // Stays "planned" — it is NOT watched, so it never touches Recent
    // Activity. queued_at just marks it as lined up next.
    await upsertEntryAndInvalidate(item.media_id, { status: 'planned', queued_at: new Date().toISOString(), queued_via: via });
    showToast(`Added "${item.title}" to your queue`);
}

// Side popup shown on the detail page after "Open" from the wheel, so the
// title can be checked out before deciding to queue it.
let queuePopupItem = null;
function showQueuePopup(item) {
    queuePopupItem = item;
    const poster = item.poster_url || (item.poster_path ? `${imgSrc(item.poster_path)}` : '');
    document.getElementById('queuePopupPoster').src = poster;
    document.getElementById('queuePopupTitle').textContent = item.title;
    document.getElementById('queuePopup').classList.remove('hidden');
}
function hideQueuePopup() {
    queuePopupItem = null;
    document.getElementById('queuePopup').classList.add('hidden');
}
document.getElementById('queuePopupClose').addEventListener('click', hideQueuePopup);
document.getElementById('queuePopupAddBtn').addEventListener('click', async (e) => {
    if (!queuePopupItem) return;
    e.currentTarget.disabled = true;
    try { await addToQueue(queuePopupItem); hideQueuePopup(); }
    catch (err) { showToast(`Couldn't add: ${err.message}`, true); }
    finally { e.currentTarget.disabled = false; }
});
els.detailBackBtn.addEventListener('click', hideQueuePopup);

// ==================== ROULETTE (random pick — reel spins, lands on one) ====================

function shuffled(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

const ROULETTE_CARD_STRIDE = 154; // 138px card + 16px gap, matches .roulette-card/.roulette-track CSS
let rouletteSpinItems = null;      // the list currently loaded, so "Pick Again" can re-spin the same pool
let rouletteSpinning = false;

function rouletteCardHtml(item) {
    const posterUrl = item.poster_url || (item.poster_path ? `${imgSrc(item.poster_path)}` : '');
    return `<div class="roulette-card"><img src="${posterUrl}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.opacity=0.3"></div>`;
}

function openRoulette(items) {
    if (!items || items.length === 0) return;
    rouletteSpinItems = items;
    els.rouletteOverlay.classList.remove('hidden');
    runRouletteSpin(items);
}

function closeRoulette() {
    els.rouletteOverlay.classList.add('hidden');
    rouletteSpinItems = null;
}

function runRouletteSpin(items) {
    if (rouletteSpinning) return;
    rouletteSpinning = true;
    els.rouletteResult.classList.add('hidden');
    els.rouletteHeading.textContent = 'Picking something for you…';

    // Enough repeated, independently-shuffled cycles for a long, satisfying
    // spin regardless of how few items are in the list. The winner is
    // whatever ends up in a random slot within the FINAL cycle — since that
    // cycle's order was itself just shuffled, this is a genuine random pick,
    // not a fixed one dressed up with animation.
    const repeats = Math.max(6, Math.ceil(40 / items.length));
    let strip = [];
    for (let i = 0; i < repeats; i++) strip = strip.concat(shuffled(items));
    const winnerIndex = strip.length - 1 - Math.floor(Math.random() * items.length);
    const winner = strip[winnerIndex];

    els.rouletteTrack.innerHTML = strip.map(rouletteCardHtml).join('');
    const cards = els.rouletteTrack.children;

    // Jump-start a bit into the strip (not translateX(0)) so the very first
    // frame already looks mid-spin instead of starting dead still.
    const viewportWidth = els.rouletteTrack.parentElement.offsetWidth;
    const startOffset = -(ROULETTE_CARD_STRIDE * 3);
    const targetOffset = -(winnerIndex * ROULETTE_CARD_STRIDE) + (viewportWidth / 2) - (ROULETTE_CARD_STRIDE / 2) + 8;

    els.rouletteTrack.style.transition = 'none';
    els.rouletteTrack.style.transform = `translateX(${startOffset}px)`;
    // Force reflow so the browser registers the jump-start position before
    // the transitioned move below — otherwise both changes get batched into
    // one frame and the "start mid-spin" effect never actually shows.
    void els.rouletteTrack.offsetWidth;

    els.rouletteTrack.style.transition = 'transform 3.8s cubic-bezier(0.11, 0.79, 0.22, 1)';
    els.rouletteTrack.style.transform = `translateX(${targetOffset}px)`;

    const onDone = () => {
        els.rouletteTrack.removeEventListener('transitionend', onDone);
        rouletteSpinning = false;
        if (cards[winnerIndex]) cards[winnerIndex].classList.add('roulette-winner-card');
        els.rouletteHeading.textContent = 'Here\'s your pick!';
        const posterUrl = winner.poster_url || (winner.poster_path ? `${imgSrc(winner.poster_path)}` : '');
        els.rouletteResultPoster.src = posterUrl;
        els.rouletteResultPoster.alt = escapeHtml(winner.title);
        els.rouletteResultTitle.textContent = winner.title;
        els.rouletteOpenBtn.onclick = () => {
            closeRoulette();
            openDetails(Number(winner.tmdb_id), winner.media_type);
            showQueuePopup(winner);
        };
        els.rouletteSaveBtn.onclick = async () => {
            els.rouletteSaveBtn.disabled = true;
            try {
                // Queue it (still "planned", not watched) — see addToQueue.
                await addToQueue(winner);
                closeRoulette();
            } catch (err) {
                showToast(`Couldn't save: ${err.message}`, true);
            } finally {
                els.rouletteSaveBtn.disabled = false;
            }
        };
        els.rouletteResult.classList.remove('hidden');
    };
    els.rouletteTrack.addEventListener('transitionend', onDone);
}

els.nextWatchRouletteBtn.addEventListener('click', () => openRoulette(plannedCache));
els.seriesNextRouletteBtn.addEventListener('click', () => openRoulette(seriesPlannedCache));
els.rouletteCloseBtn.addEventListener('click', closeRoulette);
els.rouletteOverlay.addEventListener('click', (e) => { if (e.target === els.rouletteOverlay) closeRoulette(); });
els.rouletteSpinAgainBtn.addEventListener('click', () => { if (rouletteSpinItems) runRouletteSpin(rouletteSpinItems); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.rouletteOverlay.classList.contains('hidden')) closeRoulette();
});

// ==================== FULL-PAGE MEDIA DETAILS ====================

async function openDetails(tmdbId, mediaType, { recordHistory = true } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'detail', tmdbId, mediaType };
    showPage('detail');
    // The panel floats inside the info column while a title is shown; park it back in the header before the content is replaced.
    { const pnl = document.getElementById('detailPanel'); const hdr = document.querySelector('.detail-header-actions'); if (pnl && hdr && pnl.parentElement !== hdr) hdr.appendChild(pnl); }
    els.detailContent.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
    document.getElementById('statusButtonRow').innerHTML = '';
    document.getElementById('detailPanel')?.classList.add('hidden');

    let details;
    try {
        details = await window.api.getDetails(tmdbId, mediaType);
    } catch (err) {
        els.detailContent.innerHTML = `<p class="empty-state">Couldn't load this title: ${escapeHtml(err.message)}</p>`;
        return;
    }

    const entryRef = { current: details.entry }; // mutable — status auto-save updates this in place
    const entry = entryRef.current; // snapshot for template values that don't need to react live (initial input values, textarea)
    const year = (details.release_date || '').slice(0, 4);
    let genres = [];
    try { genres = JSON.parse(details.genres || '[]'); } catch { /* ignore */ }

    const numberedSeasons = (details.seasons || []).filter((s) => s.season_number > 0);
    const hasSeasonNav = details.media_type === 'tv' && numberedSeasons.length > 1;

    // "TV Series · 1999–2007 · 6 Seasons · TV-MA · 55m · IMDb ★ 8.7 · 🍅 91%"
    // — built as a list and filtered, since several of these are missing for
    // plenty of titles (no certification data, runtime not yet aired, no
    // ratings cached yet, etc.) and a stray " · ·" from an empty piece would
    // look broken.
    const isTv = details.media_type === 'tv';
    const runtimeValue = isTv ? details.episode_runtime : details.runtime;
    const metaParts = [
        isShortFilm(details) ? 'Short Film'
            : details.is_limited_series ? 'Limited Series'
            : (TYPE_LABELS[details.media_type] || details.media_type),
        isTv && details.year_range ? details.year_range : year,
        details.certification,
        runtimeValue ? `${runtimeValue}m` : null,
        details.page_count ? `${details.page_count} pages` : null,
        details.playtime_hours ? `~${details.playtime_hours}h to play` : null,
        details.metacritic ? `Metacritic ${details.metacritic}` : null,
        typeof details.imdb_rating === 'number' ? `IMDb ★ ${details.imdb_rating.toFixed(1)}` : null,
        typeof details.rt_tomatometer === 'number' ? `🍅 ${details.rt_tomatometer}%` : null,
    ].filter(Boolean);

    // "Networks" is unified: real TV networks for shows, production companies
    // (closest analogous concept) for movies, under one label either way.
    const networksList = details.media_type === 'tv' ? details.networks : details.studios;
    let languageName = details.original_language || '';
    try {
        languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(details.original_language) || languageName;
    } catch { /* unsupported code, fall back to raw value */ }

    els.detailContent.innerHTML = `
        <div class="detail-layout">
            <div class="detail-poster-col">
                <div class="poster-frame" id="posterZoomTrigger">
                    <img src="${details.poster_url || ''}" alt="${escapeHtml(details.title)}" id="detailPosterImg">
                    <div class="poster-expand-overlay">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 3 3 3 3 8"/><polyline points="16 3 21 3 21 8"/><polyline points="21 16 21 21 16 21"/><polyline points="3 16 3 21 8 21"/></svg>
                        Expand
                    </div>
                    ${hasSeasonNav ? `
                        <button class="poster-nav prev" id="seasonPrevBtn" title="Previous season">&#10094;</button>
                        <button class="poster-nav next" id="seasonNextBtn" title="Next season">&#10095;</button>
                        <div class="season-indicator" id="seasonIndicator"></div>
                    ` : ''}
                </div>
                <div id="trailerBtnContainer"></div>
            </div>

            <div class="detail-info-col">
                <h1 class="details-title">${escapeHtml(details.title)}</h1>
                ${details.original_title && details.original_title !== details.title ? `
                    <div class="details-original-title">Original title: ${escapeHtml(details.original_title)}</div>
                ` : ''}
                <div class="details-meta">${metaParts.map(escapeHtml).join(' · ')}</div>

                <div class="metadata-grid">
                    ${details.media_type === 'tv' ? `
                        <div class="metadata-item"><div class="metadata-label">Episodes</div><div class="metadata-value">${details.number_of_episodes ?? '—'}</div></div>
                    ` : ''}
                    <div class="metadata-item"><div class="metadata-label">${details.media_type === 'tv' ? 'Networks' : details.media_type === 'book' ? 'Publisher' : details.media_type === 'game' ? 'Developer' : 'Studios'}</div><div class="metadata-value" id="studioValue">${escapeHtml((networksList || []).slice(0, 2).join(', ')) || '—'}</div></div>
                    ${details.media_type === 'game' && (details.publishers_list || []).length ? `<div class="metadata-item"><div class="metadata-label">Publisher</div><div class="metadata-value" id="gamePublisherValue">${details.publishers_list.slice(0, 2).map((p) => `<a class="studio-link" data-kind="gpublisher" data-id="${p.id}">${escapeHtml(p.name)}</a>`).join(', ')}</div></div>` : ''}
                    ${details.media_type === 'game' && (details.platforms || []).length ? `<div class="metadata-item"><div class="metadata-label">Platforms</div><div class="metadata-value">${escapeHtml(details.platforms.slice(0, 4).join(', '))}${details.platforms.length > 4 ? ` +${details.platforms.length - 4}` : ''}</div></div>` : ''}
                    <div class="metadata-item${details.media_type === 'book' || details.media_type === 'game' ? ' hidden' : ''}"><div class="metadata-label">Original Language</div><div class="metadata-value">${escapeHtml(languageName || '—')}</div></div>
                    <div class="diary-legacy hidden">
                    ${details.media_type === 'tv' ? `
                        <div class="metadata-item"><div class="metadata-label">Started Watching</div><div id="dateStartedContainer"></div></div>
                        <div class="metadata-item"><div class="metadata-label" id="dateFinishedLabel">${entry?.status === 'dropped' ? 'Date Dropped' : 'Finished Watching'}</div><div id="dateFinishedContainer"></div></div>
                    ` : `
                        <div class="metadata-item"><div class="metadata-label">Date Watched</div><div id="dateFinishedContainer"></div></div>
                    `}
                    <div class="metadata-item${entry?.status === 'rewatched' ? '' : ' hidden'}" id="dateRewatchedItem"><div class="metadata-label" id="dateRewatchedLabel">${escapeHtml(window.statusLabel('rewatched', details.media_type))} Date</div><div id="dateRewatchedContainer"></div></div>
                    </div>
                </div>

                <div class="genre-tags">
                    ${genres.map((g) => `<span class="genre-tag">${escapeHtml(g)}</span>`).join('')}
                </div>

                <div class="content-box">
                    <h3>Synopsis</h3>
                    <p>${escapeHtml(details.overview || 'No synopsis available.')}</p>
                </div>

                ${details.media_type === 'game' ? '<div class="content-box" id="achievementsHost"></div>' : ''}

                ${details.creators.length ? `
                    <div class="content-box">
                        <h3>${details.media_type === 'tv' ? 'Creators' : details.media_type === 'book' ? (details.creators.length > 1 ? 'Authors' : 'Author') : 'Director'}</h3>
                        <div class="people-grid" id="creatorsGrid"></div>
                    </div>
                ` : ''}

                ${details.media_type === 'book' ? '<div class="content-box" id="bookProgressHost"></div>' : ''}

                ${details.writers.length ? `
                    <div class="content-box">
                        <h3>Writers</h3>
                        <div class="people-grid" id="writersGrid"></div>
                    </div>
                ` : ''}

                ${details.cast.length ? `
                    <div class="content-box">
                        <h3>Stars</h3>
                        <div class="people-grid" id="castGrid"></div>
                    </div>
                ` : ''}

                ${details.awards ? `
                    <div class="content-box awards-box">
                        <h3>Awards</h3>
                        <p>${escapeHtml(details.awards)}</p>
                    </div>
                ` : ''}

                ${details.media_type === 'tv' ? `
                    <div class="content-box">
                        <div class="progress-header">
                            <h3>Watch Progress</h3>
                            <span id="progressText"></span>
                        </div>
                        <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
                    </div>
                    <div class="content-box">
                        <div class="episodes-header">
                            <h3>Episodes</h3>
                            <div id="seasonSelect"></div>
                        </div>
                        <div id="episodesList" class="episodes-list"></div>
                    </div>
                ` : ''}

                <div class="content-box personal-box hidden">
                    <div class="personal-header">
                        <h3>Your Rating &amp; Review</h3>
                        <div class="rating-row" id="detailRatingRow">
                            <span id="starsContainer"></span>
                            <button type="button" id="favoriteBtn" class="favorite-btn" title="Favorite">
                                <svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
                            </button>
                        </div>
                    </div>
                    <textarea class="review-box" id="reviewBox" placeholder="Your review…">${escapeHtml(entry?.review || '')}</textarea>
                    <button class="save-btn" id="saveEntryBtn">Save Rating &amp; Review</button>
                </div>

                <div class="related-section" id="relatedSection"></div>
                <div class="related-section" id="similarSection"></div>
            </div>
        </div>
    `;

    // click poster (or the Expand overlay) to view full screen
    document.getElementById('posterZoomTrigger').addEventListener('click', () => {
        openLightbox(document.getElementById('detailPosterImg').src);
    });

    // trailer button
    if (details.trailer_key) {
        document.getElementById('trailerBtnContainer').innerHTML = `
            <button class="trailer-btn" id="trailerBtn">
                <svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
                Watch Trailer
            </button>
        `;
        document.getElementById('trailerBtn').addEventListener('click', () => {
            window.api.openExternal(`https://www.youtube.com/watch?v=${details.trailer_key}`);
        });
    }

    if (details.creators.length) renderPeopleGrid(document.getElementById('creatorsGrid'), details.creators, null);
    if (details.writers.length) renderPeopleGrid(document.getElementById('writersGrid'), details.writers, null);
    if (details.cast.length) renderPeopleGrid(document.getElementById('castGrid'), details.cast, 'character');

    // "Related" (same franchise/collection) and "Similar" (TMDB's
    // recommendations) — both hidden entirely when there's nothing to show,
    // e.g. a movie with no collection, or a title TMDB has no data for.
    renderRelatedRow(document.getElementById('relatedSection'), details.related, 'Related');
    renderRelatedRow(document.getElementById('similarSection'), details.similar, 'Similar');

    const dateFinishedInput = createDateInput({
        container: document.getElementById('dateFinishedContainer'),
        initialISO: entry?.date_finished || null,
        onChange: async (iso) => {
            try {
                const fields = { date_finished: iso };
                // Setting a finish date means you actually finished it —
                // auto-advance to Watched/Read/Played, same idea as the
                // status-dropdown auto-date below but the other direction.
                // Never downgrades Dropped or Rewatched.
                const current = entryRef.current?.status;
                if (iso && (!current || current === 'planned' || current === 'in_progress')) fields.status = 'completed';
                entryRef.current = await upsertEntryAndInvalidate(details.mediaId, fields);
                paintStatusButtons();
                showToast('Saved!');
            } catch (err) {
                console.error('Failed to save date finished:', err);
                showToast(`Couldn't save: ${err.message}`, true);
            }
        },
    });
    const dateRewatchedInput = createDateInput({
        container: document.getElementById('dateRewatchedContainer'),
        initialISO: entry?.date_rewatched || null,
        onChange: async (iso) => {
            try {
                entryRef.current = await upsertEntryAndInvalidate(details.mediaId, { date_rewatched: iso });
                showToast('Saved!');
            } catch (err) {
                console.error('Failed to save rewatched date:', err);
                showToast(`Couldn't save: ${err.message}`, true);
            }
        },
    });
    const dateStartedContainer = document.getElementById('dateStartedContainer');
    const dateStartedInput = dateStartedContainer
        ? createDateInput({
            container: dateStartedContainer,
            initialISO: entry?.date_started || null,
            onChange: async (iso) => {
                try {
                    const fields = { date_started: iso };
                    if (iso && (!entryRef.current || entryRef.current.status === 'planned')) fields.status = 'in_progress';
                    entryRef.current = await upsertEntryAndInvalidate(details.mediaId, fields);
                    paintStatusButtons();
                    showToast('Saved!');
                } catch (err) {
                    console.error('Failed to save date started:', err);
                    showToast(`Couldn't save: ${err.message}`, true);
                }
            },
        })
        : null;

    // Status now lives as a single dropdown button in the page header
    // (top-right corner, next to Back) instead of a row of pills — it
    // shows the current status as its label/color when one is set, or a
    // neutral "Add to List" state when nothing's saved yet. Picking an
    // option saves immediately, same as before. "Remove from list" moves
    // into the menu itself (used to be a double-click on the active pill).
    // Movies only get 3 meaningful statuses — there's no realistic "still
    // watching" or "dropped" mid-way through a two-hour film the way there
    // is for a series. TV (and anything else later) keeps the full set.
    const statuses = details.media_type === 'movie'
        ? ['planned', 'completed', 'rewatched']
        : ['planned', 'in_progress', 'completed', 'dropped', 'rewatched'];
    const statusContainer = document.getElementById('statusButtonRow');

    // Queue button under the poster: only for titles not yet watched/started.
    function renderQueueBtn() {
        const box = document.getElementById('queueBtnContainer');
        if (!box) return;
        const queued = Boolean(entryRef.current?.queued_at);
        const qLabel = details.media_type === 'game' ? 'Playlist' : details.media_type === 'book' ? 'Readlist' : 'Watchlist';
        box.innerHTML = `<button type="button" class="panel-tile${queued ? ' queued' : ''}" id="queueDetailBtn">${PANEL_ICON.clock}<span>${qLabel}</span></button>`;
        document.getElementById('queueDetailBtn').addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            const hasStatus = Boolean(entryRef.current?.status);
            try {
                entryRef.current = await upsertEntryAndInvalidate(details.mediaId,
                    queued ? { queued_at: null, queued_via: null }
                        : { ...(hasStatus ? {} : { status: 'planned' }), queued_at: new Date().toISOString(), queued_via: 'manual' });
                showToast(queued ? `Removed "${details.title}" from your ${qLabel.toLowerCase()}` : `Added "${details.title}" to Up Next`);
                hideQueuePopup();
            } catch (err) {
                showToast(`Couldn't update: ${err.message}`, true);
            }
            paintStatusButtons();
        });
    }

    // Books: register the page you're on. Reaching the last page marks it as read.
    function renderBookProgress() {
        const host = document.getElementById('bookProgressHost');
        if (!host) return;
        const e = entryRef.current;
        const total = e?.page_total || details.page_count || null;
        const page = e?.current_page || 0;
        const pct = total ? Math.min(100, Math.round((page / total) * 100)) : 0;
        host.innerHTML = `
            <div class="progress-header">
                <h3>Reading Progress</h3>
                <span>${total ? `${page} of ${total} pages` : (page ? `Page ${page}` : '')}</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            <div class="bp-row">
                <label class="bp-field"><span>Current page</span><input type="number" min="0" class="bp-input" id="bpPage" value="${page || ''}" placeholder="0"></label>
                <label class="bp-field"><span>Total pages</span><input type="number" min="1" class="bp-input" id="bpTotal" value="${total || ''}" placeholder="?"></label>
                <button type="button" class="bp-btn" id="bpSave">Update</button>
            </div>`;
        const save = async () => {
            const p = Math.max(0, parseInt(document.getElementById('bpPage').value, 10) || 0);
            const t = parseInt(document.getElementById('bpTotal').value, 10) || null;
            const fields = { current_page: p, page_total: t };
            const st = entryRef.current?.status;
            const finished = Boolean(t && p >= t);
            if (finished && st !== 'completed' && st !== 'rewatched') { fields.status = 'completed'; if (!entryRef.current?.date_finished) fields.date_finished = todayISOLocal(); }
            else if (p > 0 && (!st || st === 'planned')) fields.status = 'in_progress';
            // First page registered -> start date is today (same as ticking a first episode).
            if (p > 0 && !entryRef.current?.date_started) fields.date_started = todayISOLocal();
            try {
                entryRef.current = await upsertEntryAndInvalidate(details.mediaId, fields);
                if (fields.status === 'completed') {
                    // Finishing a book adds it to the diary.
                    try { await window.api.addEntryLog({ entryId: entryRef.current.id, watchedOn: todayISOLocal(), startedOn: entryRef.current.date_started || null, isRewatch: false }); } catch { /* diary table optional */ }
                }
                showToast(fields.status === 'completed' ? `Finished "${details.title}" — marked as read` : `Saved: page ${p}${t ? ` of ${t}` : ''}`);
            } catch (err) {
                showToast(`Couldn't save progress: ${err.message}`, true);
            }
            paintStatusButtons();
        };
        document.getElementById('bpSave').addEventListener('click', save);
        host.querySelectorAll('.bp-input').forEach((i) => i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); }));
    }

    function paintStatusButtons() {
        renderBookProgress();
        renderQueueBtn();
        setTimeout(() => panelApi?.paint(), 0);
        const current = entryRef.current?.status || null;
                const tileActive = Boolean(current);
        const mt = details.media_type;
        const verb = mt === 'game' ? 'Play' : mt === 'book' ? 'Read' : 'Watch';
        const done = mt === 'game' ? 'Played' : mt === 'book' ? 'Read' : 'Watched';
        const currentLabel = !current ? verb
            : current === 'planned' ? 'Planned'
            : current === 'completed' ? done
            : current === 'rewatched' ? (mt === 'game' ? 'Replayed' : mt === 'book' ? 'Reread' : 'Rewatched')
            : current === 'in_progress' ? (mt === 'game' ? 'Playing' : mt === 'book' ? 'Reading' : 'Watching')
            : window.statusLabel(current, mt);
        const triggerClass = tileActive ? `status-pill--${current}` : 'status-dropdown-trigger--empty';

        const finishedLabel = document.getElementById('dateFinishedLabel');
        if (finishedLabel) finishedLabel.textContent = current === 'dropped' ? 'Date Dropped' : 'Finished Watching';

        const rewatchedItem = document.getElementById('dateRewatchedItem');
        if (rewatchedItem) rewatchedItem.classList.toggle('hidden', current !== 'rewatched');

        // Rebuilding this destroys whichever button the user just clicked —
        // that button still has focus at this point, and losing a focused
        // element makes the browser scroll its nearest scrollable ancestor
        // (main) back to the top by default. Blurring first (before removal)
        // avoids triggering that in the first place; the scrollTop save/
        // restore — done both synchronously and on the next frame, since the
        // browser's own adjustment doesn't always land within the same tick
        // — is a belt-and-suspenders backstop in case it still happens.
        document.activeElement?.blur();
        const mainEl = document.querySelector('main');
        const scrollPos = mainEl ? mainEl.scrollTop : 0;

        statusContainer.innerHTML = `
            <div class="status-dropdown">
                <button type="button" class="status-dropdown-trigger ${triggerClass}">
                    ${PANEL_ICON[mt === 'book' ? 'book' : mt === 'game' ? 'game' : 'eye']}<span>${currentLabel}</span>
                </button>
                <div class="status-dropdown-menu hidden">
                    ${statuses.map((s) => `
                        <button type="button" class="status-dropdown-option ${s === current ? 'active' : ''}" data-status="${s}">
                            <span class="status-dropdown-swatch status-pill--${s}"></span>
                            ${window.statusLabel(s, details.media_type)}
                        </button>
                    `).join('')}
                    ${entryRef.current ? `<button type="button" class="status-dropdown-remove">Remove from list</button>` : ''}
                </div>
            </div>
        `;
        if (mainEl) {
            mainEl.scrollTop = scrollPos;
            requestAnimationFrame(() => { mainEl.scrollTop = scrollPos; });
        }

        const root = statusContainer.querySelector('.status-dropdown');
        const trigger = root.querySelector('.status-dropdown-trigger');
        const menu = root.querySelector('.status-dropdown-menu');

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.status-dropdown-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
            document.querySelectorAll('.status-dropdown').forEach((s) => { if (s !== root) s.classList.remove('open'); });
            menu.classList.toggle('hidden');
            root.classList.toggle('open');
        });

        root.querySelectorAll('.status-dropdown-option').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const newStatus = btn.dataset.status;
                try {
                    const fields = { status: newStatus };
                    const today = todayISOLocal();
                    // Picking Watched/Read/Played, Rewatched, or Dropped
                    // directly, with no date set yet, assumes you mean
                    // "today" — mirrors the date-input side auto-advancing
                    // status the other way. Skipped once "No Date" has been
                    // explicitly chosen for that field — that's a real,
                    // deliberate answer, not a gap to fill in for you.
                    if ((newStatus === 'completed' || newStatus === 'rewatched' || newStatus === 'dropped') && !dateFinishedInput.getISO() && !dateFinishedInput.wasExplicitlyCleared()) {
                        fields.date_finished = today;
                    }
                    if (newStatus === 'rewatched' && !dateRewatchedInput.getISO() && !dateRewatchedInput.wasExplicitlyCleared()) {
                        fields.date_rewatched = today;
                    }
                    if (newStatus === 'in_progress' && dateStartedInput && !dateStartedInput.getISO() && !dateStartedInput.wasExplicitlyCleared()) {
                        fields.date_started = today;
                    }
                    entryRef.current = await upsertEntryAndInvalidate(details.mediaId, fields);
                    if (fields.date_finished) dateFinishedInput.setISO(fields.date_finished);
                    if (fields.date_rewatched) dateRewatchedInput.setISO(fields.date_rewatched);
                    if (fields.date_started) dateStartedInput.setISO(fields.date_started);
                    paintStatusButtons();
                    showToast('Saved!');
                } catch (err) {
                    console.error('Failed to save status:', err);
                    showToast(`Couldn't save status: ${err.message}`, true);
                }
            });
        });

        const removeBtn = root.querySelector('.status-dropdown-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ok = await showConfirm(`Remove "${details.title}" from your list? This clears its status, rating, and review.`);
                if (!ok) return;
                try {
                    await deleteEntryAndInvalidate(entryRef.current.id);
                    entryRef.current = null;
                    paintStatusButtons();
                    setupStarRating(0);
                    document.getElementById('reviewBox').value = '';
                    dateStartedInput?.setISO(null);
                    dateFinishedInput.setISO(null);
                    dateRewatchedInput.setISO(null);
                    showToast('Removed from your list');
                } catch (err) {
                    console.error('Failed to remove entry:', err);
                    showToast(`Couldn't remove: ${err.message}`, true);
                }
            });
        }
    }
    document.querySelector('.detail-info-col')?.prepend(document.getElementById('detailPanel'));
    (details.media_type === 'book' || details.media_type === 'game' ? Promise.resolve(details.publisher_links || []) : window.api.getTitleStudios(details.tmdb_id || details.id, details.media_type)).then((list) => {
        const host = document.getElementById('studioValue');
        if (!host || !list?.length) return;
        host.innerHTML = list.map((st) => `<a class="studio-link" data-kind="${st.kind}" data-id="${st.id}">${escapeHtml(st.name)}</a>`).join(', ');
        host.querySelectorAll('.studio-link').forEach((a) => a.addEventListener('click', () => openStudio(a.dataset.kind, Number(a.dataset.id))));
    }).catch(() => {});
    let panelApi = null;
    paintStatusButtons();
    setupListAddDropdown(details);
    if (details.media_type === 'game') {
        setupAchievements(details);
        document.querySelectorAll('#gamePublisherValue .studio-link').forEach((a) => a.addEventListener('click', () => openStudio(a.dataset.kind, Number(a.dataset.id))));
    }

    panelApi = setupDetailPanel({ details, entryRef, dateStartedInput, dateFinishedInput, dateRewatchedInput, paintStatusButtons });
    setupStarRating(entry?.rating ?? 0, entry?.is_favorite ?? false, entryRef, details.mediaId, () => panelApi?.paint());

    document.getElementById('saveEntryBtn').addEventListener('click', async () => {
        const rating = Number(document.getElementById('detailRatingRow').dataset.rating || 0);
        const review = document.getElementById('reviewBox').value || null;
        const dateStarted = dateStartedInput?.getISO() || null;
        const dateFinished = dateFinishedInput.getISO() || null;
        const dateRewatched = dateRewatchedInput.getISO() || null;

        // Rating, reviewing, or dating something implies you're actually
        // engaging with it — auto-upgrade from the default "Plan to Watch"
        // so it doesn't sit there un-started forever. Never overrides a
        // status you already deliberately chose (Watching, Dropped,
        // Completed, Rewatched).
        let status = entryRef.current?.status || 'planned';
        if ((rating || review || dateStarted || dateFinished) && status === 'planned') {
            status = details.media_type === 'movie' ? 'completed' : 'in_progress';
        }

        const fields = { status, rating: rating || null, review, date_started: dateStarted, date_finished: dateFinished, date_rewatched: dateRewatched };
        try {
            entryRef.current = await upsertEntryAndInvalidate(details.mediaId, fields);
            paintStatusButtons();
            showToast('Saved!');
        } catch (err) {
            console.error('Failed to save:', err);
            showToast(`Couldn't save: ${err.message}`, true);
        }
    });

    if (details.media_type === 'tv' && numberedSeasons.length) {
        setupEpisodes(details, entryRef, numberedSeasons, paintStatusButtons, dateStartedInput, dateFinishedInput);
    }
}

// ---------- Detail panel (right column) + diary logging modal ----------
const PANEL_ICON = {
    book: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5V5a2.5 2.5 0 0 1 2.5-2.5H20v14H6.5A2.5 2.5 0 0 0 4 19.5z"/><path d="M20 16.5V22H6.5A2.5 2.5 0 0 1 4 19.5"/><path class="ico-detail" d="M9 7h7"/></svg>',
    game: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.42.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.55-.6-6.58-.68-7.26A4 4 0 0 0 17.32 5z"/><path class="ico-detail" d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    heart: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.6-9.5-9C.9 8.6 2.6 5 6 5c2 0 3.4 1.1 6 3.6C14.6 6.1 16 5 18 5c3.4 0 5.1 3.6 3.5 7C19 16.4 12 21 12 21z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
};
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.diary-modal').forEach((n) => n.remove());
});

function setupDetailPanel({ details, entryRef, dateStartedInput, dateFinishedInput, dateRewatchedInput, paintStatusButtons }) {
    const panelEl = document.getElementById('detailPanel');
    if (!panelEl) return { paint() {} };
    const isTv = details.media_type === 'tv';
    const past = window.statusLabel('completed', details.media_type); // Watched / Read / Played
    const pastLower = past.toLowerCase();
    const year = (details.release_date || '').slice(0, 4);
    let logs = null;
    let tableOk = true;

    const fmt = (iso) => {
        if (!iso) return 'No date';
        const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
        return Number.isNaN(d.getTime()) ? 'No date' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    };
    // Real logs, or — for entries that predate the diary — the dates already on the entry.
    const rows = () => {
        if (logs && logs.length) return logs.map((l) => ({ ...l, legacy: false }));
        const e = entryRef.current;
        const out = [];
        if (e?.date_finished) out.push({ id: 'legacy-finished', watched_on: e.date_finished, started_on: e.date_started, is_rewatch: false, legacy: 'date_finished', created_at: e.date_finished });
        if (e?.date_rewatched) out.push({ id: 'legacy-rewatched', watched_on: e.date_rewatched, started_on: null, is_rewatch: true, legacy: 'date_rewatched', created_at: e.date_rewatched });
        return out;
    };
    const sortDesc = (arr) => arr.sort((a, b) => (b.watched_on || '').localeCompare(a.watched_on || '') || String(b.created_at || '').localeCompare(String(a.created_at || '')));

    async function ensureEntry() {
        if (!entryRef.current) entryRef.current = await upsertEntryAndInvalidate(details.mediaId, { status: 'planned' });
        return entryRef.current;
    }
    // Keep the entry's own fields (status + dates) in step with the log, so every other page keeps working.
    async function syncEntry(list, extra = {}) {
        const sortedAsc = [...list].filter((l) => l.watched_on).sort((a, b) => a.watched_on.localeCompare(b.watched_on));
        const firsts = sortedAsc.filter((l) => !l.is_rewatch);
        const rewatches = sortedAsc.filter((l) => l.is_rewatch);
        const fields = {
            ...extra,
            date_finished: (firsts[0] || sortedAsc[0])?.watched_on || null,
            date_rewatched: rewatches.length ? rewatches[rewatches.length - 1].watched_on : null,
        };
        const started = list.map((l) => l.started_on).filter(Boolean).sort()[0];
        if (isTv && started) fields.date_started = started;
        const cur = entryRef.current?.status;
        if (list.length >= 2 || rewatches.length) { if (cur !== 'dropped') fields.status = 'rewatched'; }
        else if (list.length === 1 && (!cur || cur === 'planned' || cur === 'in_progress')) fields.status = 'completed';
        entryRef.current = await upsertEntryAndInvalidate(details.mediaId, fields);
        dateFinishedInput.setISO(fields.date_finished);
        dateRewatchedInput.setISO(fields.date_rewatched);
        if (fields.date_started) dateStartedInput?.setISO(fields.date_started);
    }
    const loaded = (async () => {
        if (!entryRef.current) { logs = []; return; }
        try { logs = await window.api.listEntryLogs(entryRef.current.id); }
        catch { logs = null; tableOk = false; }
    })();

    async function addLog({ watchedOn, startedOn, rewatch }) {
        await ensureEntry();
        await loaded;
        if (!tableOk) throw new Error('no table');
        if (logs === null) logs = [];
        const api = (r) => window.api.addEntryLog({ entryId: entryRef.current.id, watchedOn: r.watched_on, startedOn: r.started_on, isRewatch: r.is_rewatch });
        if (logs.length === 0) {
            // First real log for an entry that already has dates: keep that history as diary rows first.
            for (const r of rows().filter((x) => x.legacy)) logs.push(await api(r));
        }
        if (rewatch && logs.length === 0) logs.push(await api({ watched_on: null, started_on: null, is_rewatch: false }));
        logs.push(await api({ watched_on: watchedOn || null, started_on: startedOn || null, is_rewatch: !!rewatch }));
        sortDesc(logs);
    }

    // ---------- panel ----------
    const likeHost = document.getElementById('panelLikeTile');
    const ratedHost = document.getElementById('panelRated');
    const logBtn = document.getElementById('panelLogBtn');
    const flyout = document.getElementById('panelFlyout');
    const activityBtn = document.getElementById('panelActivityBtn');
    const shareBtn = document.getElementById('panelShareBtn');

    function paintStars(container, rating) {
        container.querySelectorAll('.star-wrap').forEach((wrap, i) => {
            const pts = Math.max(0, Math.min(2, rating - i * 2));
            wrap.querySelector('.star-fill').style.width = `${(pts / 2) * 100}%`;
        });
    }
    const starsMarkup = [0, 1, 2, 3, 4].map((i) => `<span class="star-wrap" data-index="${i}"><span class="star-bg">★</span><span class="star-fill">★</span></span>`).join('');
    function halfValue(wrap, i, clientX) {
        const rect = wrap.getBoundingClientRect();
        return i * 2 + ((clientX - rect.left) > rect.width / 2 ? 2 : 1);
    }

    async function setRating(v) {
        try {
            const fields = { rating: v || null };
            const st = entryRef.current?.status;
            if (v && (!st || st === 'planned')) fields.status = details.media_type === 'movie' ? 'completed' : 'in_progress';
            entryRef.current = await upsertEntryAndInvalidate(details.mediaId, fields);
            document.getElementById('detailRatingRow')?._setRating?.(v || 0);
            paintStatusButtons();
        } catch (err) { showToast(`Couldn't save rating: ${err.message}`, true); }
    }

    function paint() {
        const e = entryRef.current;
        const liked = Boolean(e?.is_favorite);
        likeHost.innerHTML = `<button type="button" class="panel-tile${liked ? ' on-like' : ''}" id="panelLikeBtn">${PANEL_ICON.heart}<span>${liked ? 'Liked' : 'Like'}</span></button>`;
        document.getElementById('panelLikeBtn').addEventListener('click', () => {
            document.getElementById('favoriteBtn')?.click();
        });

        const rating = e?.rating || 0;
        ratedHost.innerHTML = `<div class="panel-rated-label">${rating ? 'Rated' : 'Rate'}</div><div class="panel-stars">${starsMarkup}</div>`;
        const starsEl = ratedHost.querySelector('.panel-stars');
        paintStars(starsEl, rating);
        starsEl.querySelectorAll('.star-wrap').forEach((wrap, i) => {
            wrap.addEventListener('click', (ev) => setRating(halfValue(wrap, i, ev.clientX)));
            wrap.addEventListener('dblclick', (ev) => { ev.preventDefault(); setRating(0); });
        });

        const list = rows();
        const st = e?.status;
        const logged = list.length > 0 || st === 'completed' || st === 'rewatched';
        logBtn.textContent = logged ? 'Log again / add review…' : 'Log in the Diary';
        activityBtn.classList.toggle('hidden', !(logged || e?.rating || e?.review));
        const hasReview = Boolean(e?.review);
        flyout.innerHTML = `<button type="button" data-act="again">Log again…</button><button type="button" data-act="review">${hasReview ? 'Edit review…' : 'Add a review…'}</button>`;
        flyout.classList.add('hidden');
    }

    logBtn.onclick = (ev) => {
        ev.stopPropagation();
        const e = entryRef.current;
        const logged = rows().length > 0 || e?.status === 'completed' || e?.status === 'rewatched';
        if (!logged) { openLogModal('log'); return; }
        flyout.classList.toggle('hidden');
    };
    flyout.onclick = (ev) => {
        const b = ev.target.closest('button[data-act]');
        if (!b) return;
        flyout.classList.add('hidden');
        openLogModal(b.dataset.act);
    };
    document.addEventListener('click', function closeFly() {
        if (!panelEl.isConnected) { document.removeEventListener('click', closeFly); return; }
        flyout.classList.add('hidden');
    });
    activityBtn.onclick = () => openActivityModal();
    shareBtn.onclick = async () => {
        const url = (isTv || details.media_type === 'movie') && details.tmdb_id
            ? `https://www.themoviedb.org/${isTv ? 'tv' : 'movie'}/${details.tmdb_id}` : `${details.title}${year ? ` (${year})` : ''}`;
        try { await navigator.clipboard.writeText(url); showToast('Link copied'); }
        catch { showToast(url); }
    };

    // ---------- "I watched…" modal ----------
    function openLogModal(mode) {
        document.querySelectorAll('.diary-modal').forEach((n) => n.remove());
        const e0 = entryRef.current;
        let rating = e0?.rating || 0;
        let liked = Boolean(e0?.is_favorite);
        const hadLogs = rows().length > 0;
        const poster = details.poster_url || '';
        const heading = mode === 'review' ? (e0?.review ? 'Edit review…' : 'Add a review…') : `I ${pastLower}…`;
        const overlay = document.createElement('div');
        overlay.className = 'diary-modal';
        overlay.innerHTML = `
            <div class="diary-modal-card dm">
                <div class="dm-head"><span>${heading}</span><button type="button" class="dm-close" title="Close">&times;</button></div>
                <div class="dm-body">
                    ${poster ? `<img class="dm-poster" src="${poster}" alt="">` : ''}
                    <div class="dm-main">
                        <div class="dm-title">${escapeHtml(details.title)} <span class="dm-year">${year}</span></div>
                        <div class="dm-dates">
                            <label class="diary-check"><input type="checkbox" id="dmWatched" ${mode === 'review' ? '' : 'checked'}><span class="diary-box-mark"></span><span>${isTv ? 'Finished on' : `${past} on`}</span></label>
                            <div id="dmWatchedHost"></div>
                            ${isTv ? '<span class="dm-sub">Started on</span><div id="dmStartedHost"></div>' : ''}
                            <label class="diary-check dm-before"><input type="checkbox" id="dmBefore" ${(mode === 'again' || (mode !== 'review' && hadLogs)) ? 'checked' : ''}><span class="diary-box-mark"></span><span>I've ${pastLower} this before</span></label>
                        </div>
                        <textarea id="dmReview" class="dm-review" placeholder="Add a review…"></textarea>
                        <label class="diary-check dm-spoil"><input type="checkbox" id="dmSpoil" ${e0?.review_spoilers ? 'checked' : ''}><span class="diary-box-mark"></span><span>Contains spoilers</span></label>
                        <div class="dm-bottom">
                            <div class="dm-rating"><div class="dm-rating-top"><span>Rating</span><span id="dmRatingText"></span></div><div class="dm-stars" id="dmStars">${starsMarkup}</div></div>
                            <div class="dm-like"><span>Like</span><button type="button" id="dmLike">${PANEL_ICON.heart}</button></div>
                        </div>
                    </div>
                </div>
                <div class="dm-foot"><button type="button" class="save-btn" id="dmSave">Save</button></div>
            </div>`;
        document.body.appendChild(overlay);
        const $ = (id) => overlay.querySelector(`#${id}`);
        const close = () => overlay.remove();
        overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
        overlay.querySelector('.dm-close').addEventListener('click', close);
        $('dmReview').value = e0?.review || '';

        const watchedInput = createDateInput({ container: $('dmWatchedHost'), initialISO: todayISOLocal(), onChange: () => {} });
        const startedInput = isTv ? createDateInput({ container: $('dmStartedHost'), initialISO: null, onChange: () => {} }) : null;
        // the date only applies while "Watched on" is ticked; "I've watched this before" alone means an earlier, undated viewing
        const syncDates = () => {
            const on = $('dmWatched').checked;
            $('dmWatchedHost').classList.toggle('dm-off', !on);
            $('dmStartedHost')?.classList.toggle('dm-off', !on);
        };
        $('dmWatched').addEventListener('change', syncDates);
        $('dmBefore').addEventListener('change', () => {
            if ($('dmBefore').checked && mode !== 'again') $('dmWatched').checked = false;
            syncDates();
        });
        syncDates();

        const starsEl = $('dmStars');
        const ratingText = () => { $('dmRatingText').textContent = `${(rating / 2).toFixed(1).replace('.0', '')} out of 5`; };
        paintStars(starsEl, rating); ratingText();
        starsEl.querySelectorAll('.star-wrap').forEach((wrap, i) => {
            wrap.addEventListener('click', (ev) => { rating = halfValue(wrap, i, ev.clientX); paintStars(starsEl, rating); ratingText(); });
            wrap.addEventListener('dblclick', (ev) => { ev.preventDefault(); rating = 0; paintStars(starsEl, 0); ratingText(); });
        });
        const likeBtn = $('dmLike');
        likeBtn.classList.toggle('on', liked);
        likeBtn.addEventListener('click', () => { liked = !liked; likeBtn.classList.toggle('on', liked); });
        if (mode === 'review') setTimeout(() => $('dmReview').focus(), 0);

        $('dmSave').addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
                const review = $('dmReview').value.trim() || null;
                const extra = { rating: rating || null, review, is_favorite: liked, review_spoilers: Boolean(review && $('dmSpoil').checked) };
                const dated = $('dmWatched').checked;
                const rewatch = $('dmBefore').checked;
                const wantsLog = dated || rewatch;
                const date = dated ? (watchedInput.getISO() || null) : null;
                const started = dated ? (startedInput?.getISO() || null) : null;
                await ensureEntry();
                if (wantsLog) {
                    try {
                        await addLog({ watchedOn: date, startedOn: started, rewatch: dated ? rewatch : false });
                        await syncEntry(logs, extra);
                    } catch (err) {
                        if (tableOk) throw err;
                        // diary table not created yet: fall back to the entry's own date fields
                        const cur = entryRef.current?.status;
                        const f = { ...extra };
                        if (!dated) { f.status = cur === 'rewatched' ? cur : 'completed'; }
                        else if (rewatch && entryRef.current?.date_finished) { f.status = 'rewatched'; f.date_rewatched = date; }
                        else { f.date_finished = date; f.status = rewatch ? 'rewatched' : (cur === 'rewatched' ? cur : 'completed'); }
                        if (isTv && started) f.date_started = started;
                        entryRef.current = await upsertEntryAndInvalidate(details.mediaId, f);
                        dateFinishedInput.setISO(entryRef.current.date_finished || null);
                        dateRewatchedInput.setISO(entryRef.current.date_rewatched || null);
                    }
                } else {
                    const f = { ...extra };
                    const st = entryRef.current?.status;
                    if ((rating || review) && (!st || st === 'planned')) f.status = details.media_type === 'movie' ? 'completed' : 'in_progress';
                    entryRef.current = await upsertEntryAndInvalidate(details.mediaId, f);
                }
                // keep the "Your Rating & Review" box on the page in step
                const reviewBox = document.getElementById('reviewBox');
                if (reviewBox) reviewBox.value = review || '';
                const row = document.getElementById('detailRatingRow');
                row?._setRating?.(rating || 0);
                row?._setFavorite?.(liked);
                paintStatusButtons();
                showToast('Saved!');
                close();
            } catch (err) {
                console.error('diary save failed:', err);
                showToast(`Couldn't save: ${err.message}`, true);
                btn.disabled = false;
            }
        });
    }

    // ---------- "Your activity for…" ----------
    function openActivityModal() {
        document.querySelectorAll('.diary-modal').forEach((n) => n.remove());
        const overlay = document.createElement('div');
        overlay.className = 'diary-modal';
        overlay.innerHTML = `
            <div class="diary-modal-card dm act-modal">
                <div class="dm-head"><span>Your activity</span><button type="button" class="dm-close" title="Close">&times;</button></div>
                <div class="act-modal-body">
                    <div class="act-modal-kicker">YOUR ACTIVITY FOR</div>
                    <div class="act-modal-title">${escapeHtml(details.title)} <span class="dm-year">${year}</span></div>
                    <div class="stats-switcher" id="actTabs">
                        <button type="button" class="stats-switch-btn active" data-tab="activity">Activity</button>
                        <button type="button" class="stats-switch-btn" data-tab="diary">Diary</button>
                        <button type="button" class="stats-switch-btn" data-tab="reviews">Reviews</button>
                    </div>
                    <div id="actBody"></div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(); });
        overlay.querySelector('.dm-close').addEventListener('click', close);
        const body = overlay.querySelector('#actBody');
        const e = entryRef.current;
        const stars = e?.rating ? ` <span class="act-stars-inline">${'★'.repeat(Math.floor(e.rating / 2))}${e.rating % 2 ? '½' : ''}</span>` : '';
        const heart = e?.is_favorite ? ' <span class="act-heart">&#9829;</span>' : '';
        const render = (tab) => {
            const list = sortDesc(rows());
            if (tab === 'activity') {
                let html = list.map((l, i) => {
                    const verb = l.is_rewatch ? `re${pastLower}` : pastLower;
                    const at = l.watched_on || l.created_at;
                    return `<div class="act-row"><div class="act-row-text"><b class="act-who">You</b> ${verb}${i === 0 && e?.rating ? ' and rated' : ''} <b>${escapeHtml(details.title)}</b>${i === 0 ? stars + heart : ''}${l.watched_on ? ` <span class="act-dim">on ${activityDate(l.watched_on)}</span>` : ''}</div><span class="act-ago">${activityAgo(at)}</span></div>`;
                }).join('');
                if (!list.length && (e?.rating || e?.is_favorite)) html = `<div class="act-row"><div class="act-row-text"><b class="act-who">You</b> ${e.rating ? 'rated' : 'liked'} <b>${escapeHtml(details.title)}</b>${stars}${heart}</div></div>`;
                body.innerHTML = `${html}<div class="act-end">End of recent activity</div>`;
            } else if (tab === 'diary') {
                body.innerHTML = list.length ? list.map((l) => `<div class="diary-row"><span class="diary-row-date">${isTv && l.started_on ? `${fmt(l.started_on)} → ` : ''}${fmt(l.watched_on)}</span>${l.is_rewatch ? '<span class="diary-row-tag">Rewatch</span>' : ''}</div>`).join('') : '<div class="act-end">Nothing in your diary yet</div>';
            } else {
                body.innerHTML = e?.review ? `<div class="act-review-full">${stars}${heart}${e.review_spoilers ? `<div class="spoiler-wrap"><div class="spoiler-warn">Contains spoilers &middot; click to reveal</div><p class="spoiler-body hidden">${escapeHtml(e.review)}</p></div>` : `<p>${escapeHtml(e.review)}</p>`}</div>` : '<div class="act-end">No review yet</div>';
            }
        };
        render('activity');
        overlay.querySelector('#actTabs').addEventListener('click', (ev) => {
            const b = ev.target.closest('.stats-switch-btn');
            if (!b) return;
            overlay.querySelectorAll('#actTabs .stats-switch-btn').forEach((x) => x.classList.toggle('active', x === b));
            render(b.dataset.tab);
        });
    }

    paint();
    panelEl.classList.remove('hidden');
    loaded.then(paint);
    return { paint };
}

// "Add to list" — a Spotify "Add to playlist"-style dropdown under the
// status button: toggles this title in/out of any of the user's own lists,
// with a quick inline "+ New List" that creates one and adds it in one go.
async function setupListAddDropdown(details) {
    const container = document.getElementById('listAddButtonRow');
    container.innerHTML = '';
    const session = await window.api.getSession();
    if (!session?.user) return; // signed out — nothing to add to

    let lists = [];
    let inListIds = new Set();
    try {
        [lists, inListIds] = await Promise.all([
            window.api.listMyLists(),
            window.api.listsContainingMedia(details.mediaId).then((ids) => new Set(ids)),
        ]);
    } catch (err) {
        console.error('Failed to load lists:', err);
        return;
    }

    function render() {
        container.innerHTML = `
            <div class="list-add-dropdown">
                <button type="button" class="list-add-dropdown-trigger">
                    <span>Add to a List</span>
                    <svg class="status-dropdown-chevron" viewBox="0 0 24 24" width="14" height="14">
                        <polyline points="6 9 12 15 18 9" fill="none" stroke="currentColor" stroke-width="2.5"/>
                    </svg>
                </button>
                <div class="list-add-dropdown-menu hidden">
                    <button type="button" class="list-add-dropdown-new">+ New List</button>
                    <div class="list-add-dropdown-options">
                        ${lists.length ? lists.map((l) => `
                            <button type="button" class="list-add-dropdown-option ${inListIds.has(l.id) ? 'in-list' : ''}" data-list-id="${l.id}">
                                <span class="list-add-dropdown-check">${inListIds.has(l.id) ? '&#10003;' : ''}</span>
                                <span class="list-add-dropdown-name">${escapeHtml(l.name)}</span>
                            </button>
                        `).join('') : `<div class="list-add-dropdown-empty">No lists yet — create one above.</div>`}
                    </div>
                </div>
            </div>
        `;
        const root = container.querySelector('.list-add-dropdown');
        const trigger = root.querySelector('.list-add-dropdown-trigger');
        const menu = root.querySelector('.list-add-dropdown-menu');

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.status-dropdown-menu, .list-add-dropdown-menu').forEach((m) => { if (m !== menu) m.classList.add('hidden'); });
            document.querySelectorAll('.status-dropdown, .list-add-dropdown').forEach((s) => { if (s !== root) s.classList.remove('open'); });
            menu.classList.toggle('hidden');
            root.classList.toggle('open');
        });

        root.querySelectorAll('.list-add-dropdown-option').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const listId = Number(btn.dataset.listId);
                const adding = !inListIds.has(listId);
                try {
                    if (adding) {
                        await window.api.addListItem(listId, details.mediaId);
                        inListIds.add(listId);
                    } else {
                        await window.api.removeListItem(listId, details.mediaId);
                        inListIds.delete(listId);
                    }
                    btn.classList.toggle('in-list', adding);
                    btn.querySelector('.list-add-dropdown-check').innerHTML = adding ? '&#10003;' : '';
                } catch (err) {
                    showToast(`Couldn't update list: ${err.message}`, true);
                }
            });
        });

        menu.addEventListener('click', (e) => e.stopPropagation());

        const newBtn = root.querySelector('.list-add-dropdown-new');
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            newBtn.outerHTML = `
                <form id="listAddDropdownNewForm" class="list-add-dropdown-new-form">
                    <input type="text" id="listAddDropdownNewInput" placeholder="List name…" maxlength="80" autocomplete="off">
                </form>
            `;
            const input = document.getElementById('listAddDropdownNewInput');
            input.focus();
            document.getElementById('listAddDropdownNewForm').addEventListener('submit', async (ev) => {
                ev.preventDefault();
                const name = input.value.trim();
                if (!name) return;
                try {
                    const created = await window.api.createList(name, '', [], false);
                    await window.api.addListItem(created.id, details.mediaId);
                    lists = [{ ...created, item_count: 1 }, ...lists];
                    inListIds.add(created.id);
                    render();
                    container.querySelector('.list-add-dropdown-menu').classList.remove('hidden');
                    container.querySelector('.list-add-dropdown').classList.add('open');
                } catch (err) {
                    showToast(`Couldn't create list: ${err.message}`, true);
                }
            });
        });
    }
    render();
}

function renderPeopleGrid(container, people, subtitleField) {
    container.innerHTML = people.map((p) => {
        const initials = p.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
        const photo = p.profile_path
            ? `<img src="${/^https?:/.test(p.profile_path) ? p.profile_path : `https://image.tmdb.org/t/p/w185${p.profile_path}`}" alt="${escapeHtml(p.name)}">`
            : `<div class="person-avatar-fallback">${initials}</div>`;
        return `
            <div class="person-card" data-person-id="${p.id}">
                <div class="person-avatar">${photo}</div>
                <div>
                    <div class="person-name">${escapeHtml(p.name)}</div>
                    ${subtitleField && p[subtitleField] ? `<div class="person-subtitle">${escapeHtml(p[subtitleField])}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');
    container.querySelectorAll('.person-card').forEach((card) => {
        card.addEventListener('click', () => openPerson(Number(card.dataset.personId)));
    });
}

// Renders a "Related Films" / "Similar Series" style horizontal poster row
// at the bottom of the detail page. Hides the whole section (heading
// included) when there's nothing to show.
function renderRelatedRow(container, items, headingPrefix) {
    if (!items || items.length === 0) { container.innerHTML = ''; return; }
    // titles with no release date yet go last, the rest keep their order
    items = [...items].sort((a, b) => (a.release_date ? 0 : 1) - (b.release_date ? 0 : 1));
    const plural = TYPE_LABELS_PLURAL[items[0].media_type] || 'Titles';
    container.innerHTML = `
        <h3>${headingPrefix} ${plural}</h3>
        <div class="related-row">
            ${items.map((item) => `
                <div class="related-item" data-tmdb-id="${item.tmdb_id}" data-media-type="${item.media_type}">
                    <img src="${item.poster_url || ''}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.opacity=0.3">
                    ${statusFlag(item.status)}
                    <div class="related-title">${escapeHtml(item.title)}</div>
                    <div class="related-year">${(item.release_date || '').slice(0, 4)}</div>
                </div>
            `).join('')}
        </div>
    `;
    container.querySelectorAll('.related-item').forEach((el) => {
        el.addEventListener('click', () => openDetails(Number(el.dataset.tmdbId), el.dataset.mediaType));
    });
}

function setupStarRating(initialRating, initialFavorite, entryRef, mediaId, onSaved) {
    // initialRating is stored 0-10 (2 points per star). Build 5 stars, each
    // able to register a half-point click via cursor x-position. Double-click
    // any star to clear the rating — saved immediately, doesn't touch
    // status/review/dates.
    //
    // The heart is mutually exclusive with a star score, not an addition to
    // it — a favorite is beyond rating on the 5-star scale, not a 6th
    // point on it. Picking one clears the other.
    const row = document.getElementById('detailRatingRow');
    const starsContainer = document.getElementById('starsContainer');
    const heartBtn = document.getElementById('favoriteBtn');
    row.dataset.rating = initialRating;
    row.title = 'Double-click a star to clear your rating';
    let isFavorite = Boolean(initialFavorite);
    heartBtn.classList.toggle('active', isFavorite);

    starsContainer.innerHTML = [0, 1, 2, 3, 4].map((i) => `
        <span class="star-wrap" data-index="${i}">
            <span class="star-bg">★</span>
            <span class="star-fill">★</span>
        </span>
    `).join('');

    const wraps = starsContainer.querySelectorAll('.star-wrap');

    function paint(rating) {
        wraps.forEach((wrap, i) => {
            const pointsForThisStar = Math.max(0, Math.min(2, rating - i * 2));
            wrap.querySelector('.star-fill').style.width = `${(pointsForThisStar / 2) * 100}%`;
        });
    }
    paint(initialRating);
    row._setRating = (v) => { row.dataset.rating = v; paint(v); };
    row._setFavorite = (f) => { isFavorite = Boolean(f); heartBtn.classList.toggle('active', isFavorite); };

    wraps.forEach((wrap, i) => {
        wrap.addEventListener('click', async (e) => {
            const rect = wrap.getBoundingClientRect();
            const clickedRightHalf = (e.clientX - rect.left) > rect.width / 2;
            const value = i * 2 + (clickedRightHalf ? 2 : 1);
            row.dataset.rating = value;
            paint(value);
        });
        wrap.addEventListener('dblclick', async (e) => {
            e.preventDefault();
            row.dataset.rating = 0;
            paint(0);
            if (entryRef?.current && mediaId) {
                try {
                    entryRef.current = await upsertEntryAndInvalidate(mediaId, { rating: null });
                    onSaved?.();
                    showToast('Saved!');
                } catch (err) {
                    console.error('Failed to clear rating:', err);
                    showToast(`Couldn't clear rating: ${err.message}`, true);
                }
            }
        });
    });

    heartBtn.addEventListener('click', async () => {
        const next = !isFavorite;
        isFavorite = next;
        heartBtn.classList.toggle('active', next);
        heartBtn.disabled = true;
        const fields = { is_favorite: next }; // liking and rating are independent
        try {
            entryRef.current = await upsertEntryAndInvalidate(mediaId, fields);
            onSaved?.();
            showToast(next ? 'Added to favorites' : 'Removed from favorites');
        } catch (err) {
            isFavorite = !next;
            heartBtn.classList.toggle('active', isFavorite);
            console.error('Failed to update favorite:', err);
            showToast(`Couldn't save: ${err.message}`, true);
        } finally {
            heartBtn.disabled = false;
        }
    });
}

async function setupEpisodes(details, entryRef, numberedSeasons, onEntryCreated, dateStartedInput, dateFinishedInput) {
    const seasonOptions = numberedSeasons.map((s) => ({ value: String(s.season_number), label: s.name || `Season ${s.season_number}` }));

    let watchedIds = new Set();
    if (entryRef.current) {
        watchedIds = new Set(await window.api.getWatchedEpisodes(entryRef.current.id));
    }

    // A show marked Watched only stays Watched while every episode actually
    // is — if a new season/episode aired since then, watchedIds will now be
    // short of the current total, so drop it back to Watching automatically
    // rather than silently leaving it marked complete.
    if (entryRef.current?.status === 'completed' && details.aired_episode_count && watchedIds.size < details.aired_episode_count) {
        try {
            entryRef.current = await upsertEntryAndInvalidate(details.mediaId, { status: 'in_progress' });
            onEntryCreated?.();
            showToast('New episodes available — moved back to Watching');
        } catch (err) {
            console.error('Failed to auto-revert status for new episodes:', err);
        }
    }

    // Resume where you stopped — default to the season containing the
    // furthest-watched episode instead of always Season 1. Falls back to 0
    // for a fresh show with nothing watched yet.
    let initialSeasonIdx = 0;
    if (entryRef.current) {
        try {
            const lastSeasonNumber = await window.api.getLastWatchedSeason(entryRef.current.id);
            if (lastSeasonNumber != null) {
                const idx = numberedSeasons.findIndex((s) => s.season_number === lastSeasonNumber);
                if (idx !== -1) initialSeasonIdx = idx;
            }
        } catch (err) {
            console.error('Failed to look up last watched season:', err);
        }
    }

    let currentSeasonIdx = initialSeasonIdx;
    const posterImg = document.getElementById('detailPosterImg');
    const seasonIndicator = document.getElementById('seasonIndicator');
    const prevBtn = document.getElementById('seasonPrevBtn');
    const nextBtn = document.getElementById('seasonNextBtn');

    // No point showing a picker with nothing to pick between — a single
    // numbered season (this covers limited series too, which are almost
    // always exactly one season) just gets the plain Episodes list.
    let seasonDropdown = null;
    if (numberedSeasons.length > 1) {
        seasonDropdown = createCustomSelect({
            container: document.getElementById('seasonSelect'),
            options: seasonOptions,
            value: String(numberedSeasons[initialSeasonIdx].season_number),
            onChange: (v) => selectSeason(numberedSeasons.findIndex((s) => String(s.season_number) === v)),
        });
    }

    function updateProgress(totalWatched, totalEpisodes) {
        const pct = totalEpisodes ? Math.round((totalWatched / totalEpisodes) * 100) : 0;
        document.getElementById('progressFill').style.width = `${pct}%`;
        document.getElementById('progressText').textContent = `${totalWatched} of ${totalEpisodes} episodes watched`;
    }
    updateProgress(watchedIds.size, details.aired_episode_count || 0);

    function selectSeason(idx) {
        currentSeasonIdx = idx;
        const season = numberedSeasons[idx];
        if (posterImg && season.poster_url) posterImg.src = season.poster_url;
        if (seasonIndicator) seasonIndicator.textContent = season.name || `Season ${season.season_number}`;
        seasonDropdown?.setValue(String(season.season_number));
        loadSeason(season.season_number);
    }

    if (prevBtn) prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectSeason((currentSeasonIdx - 1 + numberedSeasons.length) % numberedSeasons.length);
    });
    if (nextBtn) nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectSeason((currentSeasonIdx + 1) % numberedSeasons.length);
    });

    async function loadSeason(seasonNumber) {
        const list = document.getElementById('episodesList');
        list.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
        const episodes = await window.api.getSeasonEpisodes(details.mediaId, details.tmdb_id, seasonNumber);
        list.innerHTML = episodes.map((ep) => `
            <div class="episode-row">
                <div>
                    <div class="episode-title">${seasonNumber}x${String(ep.episode_number).padStart(2, '0')} – ${escapeHtml(ep.name || '')}</div>
                    <div class="episode-meta">${ep.air_date ? 'Air Date: ' + formatDateDMY(ep.air_date) : ''}</div>
                </div>
                <input type="checkbox" class="episode-checkbox" data-episode-id="${ep.id}" ${watchedIds.has(ep.id) ? 'checked' : ''}>
            </div>
        `).join('');

        list.querySelectorAll('.episode-checkbox').forEach((cb) => {
            cb.addEventListener('change', async () => {
                const wasWatchedCountBefore = watchedIds.size;
                try {
                    if (!entryRef.current) {
                        entryRef.current = await upsertEntryAndInvalidate(details.mediaId, { status: 'in_progress' });
                        onEntryCreated?.();
                    }
                    const episodeId = Number(cb.dataset.episodeId);
                    // toggleEpisodeWatched returns the fresh authoritative watched-list
                    // from the DB — use that directly instead of mutating our own copy,
                    // so the progress bar can never drift out of sync with what's saved.
                    const updatedWatchedIds = await toggleEpisodeWatchedAndInvalidate(entryRef.current.id, episodeId, cb.checked);
                    watchedIds = new Set(updatedWatchedIds);
                    updateProgress(watchedIds.size, details.aired_episode_count || 0);

                    if (cb.checked) {
                        const autoFields = {};
                        const today = todayISOLocal();

                        // First episode ever watched -> move to Watching and set a start date.
                        // Only promotes from "Plan to Watch" — a Dropped show stays Dropped
                        // even if you're filling in which episodes you'd already seen before
                        // dropping it, and an already-typed (even unsaved) start date is left
                        // alone instead of being overwritten with today.
                        if (wasWatchedCountBefore === 0 && watchedIds.size > 0) {
                            if (entryRef.current.status === 'planned') autoFields.status = 'in_progress';
                            const currentStartISO = dateStartedInput?.getISO();
                            if (!entryRef.current.date_started && !currentStartISO) autoFields.date_started = today;
                        }
                        // Every episode now watched -> mark Completed and set a finish date
                        if (details.aired_episode_count && watchedIds.size === details.aired_episode_count && entryRef.current.status !== 'completed') {
                            autoFields.status = 'completed';
                            autoFields.date_finished = today;
                        }
                        if (Object.keys(autoFields).length) {
                            entryRef.current = await upsertEntryAndInvalidate(details.mediaId, autoFields);
                            onEntryCreated?.(); // refresh the status pill row to reflect the change
                            if (dateStartedInput && autoFields.date_started) dateStartedInput.setISO(autoFields.date_started);
                            if (dateFinishedInput && autoFields.date_finished) dateFinishedInput.setISO(autoFields.date_finished);
                        }
                    }
                } catch (err) {
                    console.error('Failed to update episode watch state:', err);
                    showToast(`Couldn't save: ${err.message}`, true);
                    cb.checked = !cb.checked;
                }
            });
        });
    }

    selectSeason(initialSeasonIdx);
}

// ==================== PERSON PAGE ====================

// "April 17, 2011" style — used on the full search-results page where
// there's room for a real date, unlike the compact poster badges elsewhere.
function formatFullDate(isoDate) {
    if (!isoDate) return 'Release date unknown';
    const d = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return 'Release date unknown';
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// TMDB's standard genre set (stable, documented IDs) — covers both movie
// and TV, since search results mix both media types.
const GENRE_NAMES = {
    28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
    99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
    27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
    10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
    10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
    10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};
const SEARCH_SORT_OPTIONS = [
    { value: 'relevance', label: 'Relevance' },
    { value: 'release_date', label: 'Release Date' },
    { value: 'popularity', label: 'Popularity' },
    { value: 'rating', label: 'Rating' },
    { value: 'alphabetical', label: 'Alphabetical' },
];

let searchFilterState = { decade: null, genre: null, sort: 'relevance', ascending: false, type: 'all' };
let lastSearchMembers = [];

function decadeOf(dateStr) {
    if (!dateStr) return null;
    const year = Number(dateStr.slice(0, 4));
    return Number.isFinite(year) ? Math.floor(year / 10) * 10 : null;
}

// Filters/sorts whatever's already loaded for the CURRENT server page —
// TMDB's text-search endpoint doesn't support genre/decade filtering
// server-side, and re-fetching every page just to filter client-side would
// mean hammering TMDB on every keystroke. Person results never match a
// decade/genre filter (they don't have one), so they drop out of the list
// whenever either filter is active — same as Letterboxd limiting its
// decade/genre filters to actual titles.
function applySearchFilters(results) {
    let filtered = results;
    if (searchFilterState.decade != null) {
        filtered = filtered.filter((r) => r.media_type !== 'person' && decadeOf(r.release_date) === searchFilterState.decade);
    }
    if (searchFilterState.genre != null) {
        filtered = filtered.filter((r) => r.media_type !== 'person' && (r.genre_ids || []).includes(searchFilterState.genre));
    }

    const sorted = [...filtered];
    switch (searchFilterState.sort) {
        case 'release_date':
            sorted.sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));
            break;
        case 'popularity':
            sorted.sort((a, b) => (a.popularity || 0) - (b.popularity || 0));
            break;
        case 'rating':
            sorted.sort((a, b) => (a.vote_average ?? -1) - (b.vote_average ?? -1));
            break;
        case 'alphabetical':
            sorted.sort((a, b) => a.title.localeCompare(b.title));
            break;
        case 'relevance':
        default:
            return searchFilterState.ascending ? sorted.reverse() : sorted; // TMDB's own ranking — reverse is the only "direction" that means anything
    }
    if (!searchFilterState.ascending) sorted.reverse();
    return sorted;
}

let lastSearchResults = [];
let lastSearchQuery = '';
let lastSearchPage = 1;
let lastSearchTotalPages = 1;

async function openSearchResults(query, { recordHistory = true, page = 1 } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'search', query, page };
    showPage('search');
    els.searchPageTitle.textContent = `Results for "${query}"`;
    els.searchPageResults.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
    searchFilterState = { decade: null, genre: null, sort: 'relevance', ascending: false, type: 'all' }; // fresh filters per search — a carried-over decade/genre from a previous query would be surprising

    let data;
    const membersPromise = window.api.searchMembers(query).catch(() => []);
    try {
        data = await searchWithYear(query, page);
    } catch (err) {
        els.searchPageResults.innerHTML = `<p class="empty-state">Couldn't search: ${escapeHtml(err.message)}</p>`;
        return;
    }
    lastSearchMembers = await membersPromise;
    const { results, totalPages, totalResults } = data;

    if (results.length === 0 && lastSearchMembers.length === 0) {
        els.searchPageTitle.textContent = `Results for "${query}"`;
        els.searchPageResults.innerHTML = `<p class="empty-state">No results for "${escapeHtml(query)}".</p>`;
        return;
    }

    els.searchPageTitle.textContent = `Results for "${query}" (${totalResults})`;
    lastSearchResults = results;
    lastSearchQuery = query;
    lastSearchPage = page;
    lastSearchTotalPages = totalPages;

    createCustomSelect({
        container: document.getElementById('searchTypeFilter'),
        options: [{ value: 'all', label: 'All Results' }, { value: 'titles', label: 'Films & Series' }, { value: 'books', label: 'Books' }, { value: 'games', label: 'Games' }, { value: 'people', label: 'Cast, Crew & Authors' }, { value: 'members', label: 'Members' }],
        value: 'all',
        onChange: (v) => { searchFilterState.type = v; renderSearchResultsList(); },
    });
    createCustomSelect({
        container: document.getElementById('searchDecadeFilter'),
        options: [{ value: '', label: 'Any Decade' }, ...Array.from({ length: 14 }, (_, i) => {
            const d = 2020 - i * 10;
            return { value: String(d), label: `${d}s` };
        })],
        value: '',
        onChange: (v) => { searchFilterState.decade = v ? Number(v) : null; renderSearchResultsList(); },
    });
    createCustomSelect({
        container: document.getElementById('searchGenreFilter'),
        options: [{ value: '', label: 'Any Genre' }, ...Object.entries(GENRE_NAMES).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => ({ value: id, label: name }))],
        value: '',
        onChange: (v) => { searchFilterState.genre = v ? Number(v) : null; renderSearchResultsList(); },
    });
    createCustomSelect({
        container: document.getElementById('searchSort'),
        options: SEARCH_SORT_OPTIONS,
        value: searchFilterState.sort,
        onChange: (v) => { searchFilterState.sort = v; renderSearchResultsList(); },
    });
    const dirBtn = document.getElementById('searchSortDir');
    dirBtn.classList.toggle('ascending', searchFilterState.ascending);
    dirBtn.onclick = () => {
        searchFilterState.ascending = !searchFilterState.ascending;
        dirBtn.classList.toggle('ascending', searchFilterState.ascending);
        renderSearchResultsList();
    };

    renderSearchResultsList();
}

function renderSearchResultsList() {
    const type = searchFilterState.type;
    let results = applySearchFilters(lastSearchResults);
    if (type === 'titles') results = results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
    else if (type === 'books') results = results.filter((r) => r.media_type === 'book');
    else if (type === 'games') results = results.filter((r) => r.media_type === 'game');
    else if (type === 'people') results = results.filter((r) => r.media_type === 'person');
    else if (type === 'members') results = [];
    const filtersActive = searchFilterState.decade != null || searchFilterState.genre != null;
    const members = (type === 'all' || type === 'members') && !filtersActive ? lastSearchMembers : [];
    const query = lastSearchQuery;
    const page = lastSearchPage;
    const totalPages = lastSearchTotalPages;

    if (results.length === 0 && members.length === 0) {
        els.searchPageResults.innerHTML = `<p class="empty-state">No results on this page match those filters.</p>`;
        return;
    }

    const membersHtml = members.length ? `<div class="search-members member-list"><div class="search-members-title">MEMBERS</div>${members.map(memberRowHtml).join('')}</div>` : '';
    const rowsHtml = results.map((r) => {
        const posterUrl = r.poster_url || (r.poster_path ? `${imgSrc(r.poster_path)}` : '');
        if (r.media_type === 'person') {
            return `
                <div class="search-page-row" data-tmdb-id="${r.tmdb_id}" data-media-type="person">
                    <div class="search-page-row-poster search-page-row-poster-person">
                        <img src="${posterUrl}" alt="${escapeHtml(r.title)}" loading="lazy" onerror="this.style.opacity=0.3">
                    </div>
                    <div class="search-page-row-info">
                        <div class="search-page-row-title">${escapeHtml(r.title)}</div>
                        <div class="search-page-row-meta">${escapeHtml(r.department || 'Person')}</div>
                    </div>
                </div>
            `;
        }
        // TV shows a running year range ("2011–2016" / "2011–Present") when
        // TMDB has enough data to build one; movies (and TV without one)
        // fall back to the full release date.
        const dateLine = r.media_type === 'tv' && r.yearRange ? r.yearRange : formatFullDate(r.release_date);
        const creatorHtml = r.creator ? `
            <div class="search-page-row-creator">${r.creator.label}
                ${r.creator.people.map((p) => `<a href="#" class="search-page-person-link" data-person-id="${p.id}">${escapeHtml(p.name)}</a>`).join(', ')}
            </div>
        ` : '';
        return `
            <div class="search-page-row" data-tmdb-id="${r.tmdb_id}" data-media-type="${r.media_type}">
                <div class="poster-img-wrap search-page-row-poster">
                    <img src="${posterUrl}" alt="${escapeHtml(r.title)}" loading="lazy" onerror="this.style.opacity=0.3">
                    ${statusFlag(r.status)}
                </div>
                <div class="search-page-row-info">
                    <div class="search-page-row-title">${escapeHtml(r.title)}</div>
                    <div class="search-page-row-meta">${TYPE_LABELS[r.media_type] || r.media_type} · ${dateLine}</div>
                    ${r.overview ? `<p class="search-page-row-overview">${escapeHtml(r.overview)}</p>` : ''}
                    ${creatorHtml}
                </div>
            </div>
        `;
    }).join('');

    const paginationHtml = totalPages > 1 ? `
        <div class="search-page-pagination">
            <button type="button" class="search-page-page-btn" id="searchPagePrev" ${page <= 1 ? 'disabled' : ''}><svg class="back-btn-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Prev</button>
            <span class="search-page-page-indicator">Page ${page} of ${totalPages}</span>
            <button type="button" class="search-page-page-btn" id="searchPageNext" ${page >= totalPages ? 'disabled' : ''}>Next &rarr;</button>
        </div>
    ` : '';

    els.searchPageResults.innerHTML = (type === 'members' ? membersHtml : rowsHtml + membersHtml) + (type === 'members' ? '' : paginationHtml);
    wireMemberRows(els.searchPageResults, members);

    els.searchPageResults.querySelectorAll('.search-page-row').forEach((row) => {
        row.addEventListener('click', () => {
            if (row.dataset.mediaType === 'person') {
                openPerson(Number(row.dataset.tmdbId));
            } else {
                openDetails(Number(row.dataset.tmdbId), row.dataset.mediaType);
            }
        });
    });
    els.searchPageResults.querySelectorAll('.search-page-person-link').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPerson(Number(link.dataset.personId));
        });
    });
    // Pagination doesn't push a new history entry per page — Back should
    // return to wherever you were before you searched, not step backward
    // through page 3 -> page 2 -> page 1 one click at a time.
    document.getElementById('searchPagePrev')?.addEventListener('click', () => openSearchResults(query, { recordHistory: false, page: page - 1 }));
    document.getElementById('searchPageNext')?.addEventListener('click', () => openSearchResults(query, { recordHistory: false, page: page + 1 }));
}

async function openStudio(kind, id, { recordHistory = true } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'studio', kind, id };
    showPage('person');
    els.personContent.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
    let st;
    try { st = await window.api.getStudio(kind, id); }
    catch (err) { els.personContent.innerHTML = `<p class="empty-state">Couldn't load this studio: ${escapeHtml(err.message)}</p>`; return; }
    const label = st.kind === 'network' ? 'Network' : st.kind === 'publisher' || st.kind === 'gpublisher' ? 'Publisher' : st.kind === 'developer' ? 'Developer' : 'Studio';
    const parent = st.parent ? ` · Part of <a class="studio-link" id="studioParentLink">${escapeHtml(st.parent.name)}</a>` : '';
    await renderEntityPage({
        name: st.name,
        meta: escapeHtml([label, st.headquarters, st.origin_country].filter(Boolean).join(' · ')) + parent,
        bio: st.description || '',
        imageUrl: st.logo_url || '',
        logo: true,
        credits: st.credits || [],
        follow: {
            is: () => window.api.isFollowingStudio(kind, Number(id)),
            add: async () => { await window.api.followStudio(kind, Number(id), st.name, st.logo_path); profileStudiosCache = null; },
            remove: async () => { await window.api.unfollowStudio(kind, Number(id)); profileStudiosCache = null; },
        },
    });
    document.getElementById('studioParentLink')?.addEventListener('click', () => openStudio(st.parent.kind, st.parent.id));
}

// ---- Person / studio / author / developer pages share one profile-style layout ----
// Banner (most recent work as the backdrop), a clickable round picture, one tab per kind of media and a
// last "Appearances" tab for guest / self credits.
const ENTITY_TABS = [['movie', 'Films'], ['tv', 'Series'], ['book', 'Books'], ['game', 'Videogames']];
const ENTITY_SORT_OPTIONS = [
    { value: 'popularity', label: 'Most Popular' },
    { value: 'release_date', label: 'Release Date' },
    { value: 'rating', label: 'Rating' },
];

function renderEntityCredits(container, credits, primaryDept, fallbackTitle) {
    const bySection = {};
    for (const c of credits) (bySection[c.section || fallbackTitle] ||= []).push(c);
    const order = ['Books', 'Directing', 'Writing', 'Production', 'Acting', 'Crew', fallbackTitle];
    if (order.includes(primaryDept)) { order.splice(order.indexOf(primaryDept), 1); order.unshift(primaryDept); }
    const sections = [...new Set([...order, ...Object.keys(bySection)])].filter((x) => bySection[x]?.length);
    const sortCredits = (items, how) => {
        const arr = [...items];
        if (how === 'release_date') arr.sort((x, y) => (y.release_date || '').localeCompare(x.release_date || ''));
        else if (how === 'rating') arr.sort((x, y) => (y.vote_average || 0) - (x.vote_average || 0));
        else arr.sort((x, y) => (y.popularity || 0) - (x.popularity || 0));
        return arr;
    };
    const key = (x) => x.replace(/[^a-z0-9]+/gi, '');
    const sortState = {}, expanded = {};
    container.innerHTML = sections.map((sec) => `
        <div class="content-box">
            <div class="poster-row-header">
                <h3>${escapeHtml(sec)} (${bySection[sec].length})</h3>
                <div class="poster-row-header-controls">
                    <div data-sort="${key(sec)}"></div>
                    ${bySection[sec].length > 18 ? `<button type="button" class="view-all-btn" data-more="${key(sec)}">View All</button>` : ''}
                </div>
            </div>
            <div class="poster-grid film-grid" data-grid="${key(sec)}"></div>
        </div>`).join('') || '<p class="profile-tab-empty">Nothing found.</p>';
    const paint = (sec) => {
        const grid = container.querySelector(`[data-grid="${key(sec)}"]`);
        const sorted = sortCredits(bySection[sec], sortState[sec]);
        grid.innerHTML = (expanded[sec] ? sorted : sorted.slice(0, 18)).map((c) => `
            <div class="poster-card" data-tmdb-id="${c.tmdb_id}" data-media-type="${c.media_type}">
                <div class="poster-img-wrap">
                    <img src="${c.poster_url || (c.poster_path ? imgSrc(c.poster_path) : '')}" alt="${escapeHtml(c.title)}" loading="lazy" onerror="this.style.opacity=0.3">
                    ${statusFlag(c.status)}
                    <div class="film-card-overlay">
                        <div class="film-card-title">${escapeHtml(c.title)}${c.release_date ? ` (${c.release_date.slice(0, 4)})` : ''}</div>
                        ${c.role ? `<div class="film-card-role">as ${escapeHtml(c.role)}</div>` : ''}
                    </div>
                </div>
            </div>`).join('');
        grid.querySelectorAll('.poster-card').forEach((card) => card.addEventListener('click', () => openDetails(Number(card.dataset.tmdbId), card.dataset.mediaType)));
    };
    sections.forEach((sec) => {
        sortState[sec] = 'popularity';
        const host = container.querySelector(`[data-sort="${key(sec)}"]`);
        if (host) createCustomSelect({ container: host, options: ENTITY_SORT_OPTIONS, value: 'popularity', onChange: (v) => { sortState[sec] = v; paint(sec); } });
        paint(sec);
    });
    container.querySelectorAll('[data-more]').forEach((btn) => btn.addEventListener('click', () => {
        const sec = sections.find((x) => key(x) === btn.dataset.more);
        expanded[sec] = !expanded[sec];
        btn.textContent = expanded[sec] ? 'Show Less' : 'View All';
        paint(sec);
    }));
}

// o: { name, meta, bio, imageUrl, logo, credits, primaryDept, follow: { is(), add(), remove() } }
async function renderEntityPage(o) {
    const credits = o.credits || [];
    const selfs = credits.filter((c) => c.section === 'As Themselves');
    const rest = credits.filter((c) => c.section !== 'As Themselves');
    const groups = Object.fromEntries(ENTITY_TABS.map(([k]) => [k, rest.filter((c) => c.media_type === k)]));
    const tabs = ENTITY_TABS.filter(([k]) => groups[k].length).map(([k, label]) => ({ key: k, label, items: groups[k] }));
    if (selfs.length) tabs.push({ key: 'self', label: 'Appearances', items: selfs });
    let active = tabs.slice().sort((x, y) => (x.key === 'self') - (y.key === 'self') || y.items.length - x.items.length)[0]?.key || null;
    const initial = escapeHtml((o.name || '?').trim().charAt(0).toUpperCase());

    els.personContent.innerHTML = `
        <div class="profile-banner official-banner">
            <div class="profile-banner-bg" id="entityBannerBg"></div>
            <div class="profile-banner-header">
                <div class="profile-avatar-wrap"><div class="profile-avatar-large entity-avatar${o.logo ? ' entity-avatar-logo' : ''}${o.imageUrl ? ' clickable' : ''}" id="entityAvatar" title="${o.imageUrl ? 'View picture' : ''}">${o.imageUrl ? `<img src="${escapeHtml(o.imageUrl)}" alt="${escapeHtml(o.name)}" onerror="this.remove()">` : `<span>${initial}</span>`}</div></div>
                <div class="profile-header-info">
                    <div class="profile-name-row">
                        <h1 class="profile-name-display">${escapeHtml(o.name)}</h1>
                        <button type="button" id="entityFollowBtn" class="official-follow-btn">FOLLOW</button>
                    </div>
                    ${o.meta ? `<div class="entity-meta">${o.meta}</div>` : ''}
                    ${o.bio ? `<p class="profile-bio-display entity-bio" id="entityBio" title="Click to expand">${escapeHtml(o.bio)}</p>` : ''}
                </div>
                <div class="profile-stats-row">
                    ${tabs.map((t) => `<div data-tab="${t.key}"><div class="profile-stat-num">${t.items.length}</div><div class="profile-stat-label">${t.label}</div></div>`).join('')}
                </div>
            </div>
        </div>
        <div class="profile-body">
            <div class="profile-tabs" id="entityTabs">${tabs.map((t) => `<button type="button" class="profile-tab${t.key === active ? ' active' : ''}" data-tab="${t.key}">${t.label} <span class="entity-tab-n">${t.items.length}</span></button>`).join('')}</div>
            <div id="entityTabBody"></div>
        </div>`;

    const body = document.getElementById('entityTabBody');
    const showTab = (k) => {
        active = k;
        document.querySelectorAll('#entityTabs .profile-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === k));
        const t = tabs.find((x) => x.key === k);
        if (!t) { body.innerHTML = '<p class="profile-tab-empty">Nothing found.</p>'; return; }
        renderEntityCredits(body, t.items, o.primaryDept, t.label);
    };
    showTab(active);
    document.querySelectorAll('#entityTabs .profile-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    document.querySelectorAll('.profile-stats-row [data-tab]').forEach((d) => d.addEventListener('click', () => showTab(d.dataset.tab)));
    document.getElementById('entityBio')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('expanded'));
    if (o.imageUrl) document.getElementById('entityAvatar').addEventListener('click', () => openLightbox(o.imageUrl));

    // Backdrop: the most recent thing they worked on.
    window.api.getEntityBanner(rest.concat(selfs).map((c) => ({ tmdb_id: c.tmdb_id, media_type: c.media_type, release_date: c.release_date, poster_path: c.poster_path })))
        .then((url) => {
            const bg = document.getElementById('entityBannerBg');
            if (!url || !bg) return;
            bg.style.backgroundImage = `url('${url}')`;
            bg.style.backgroundSize = 'cover';
            bg.style.backgroundPosition = 'center 25%';
        }).catch(() => {});

    // Follow
    const btn = document.getElementById('entityFollowBtn');
    let following = false;
    try { following = await o.follow.is(); } catch (err) { console.error('Failed to load follow state:', err); }
    const paintFollow = () => { btn.textContent = following ? 'FOLLOWING' : 'FOLLOW'; btn.classList.toggle('following', following); };
    paintFollow();
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            if (following) await o.follow.remove(); else await o.follow.add();
            following = !following;
            paintFollow();
        } catch (err) { showToast(`Couldn't update follow: ${err.message}`, true); }
        finally { btn.disabled = false; }
    });
}

async function openPerson(personId, { recordHistory = true } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'person', personId };
    showPage('person');
    els.personContent.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
    let person;
    try { person = await window.api.getPerson(personId); }
    catch (err) { els.personContent.innerHTML = `<p class="empty-state">Couldn't load this person: ${escapeHtml(err.message)}</p>`; return; }
    await renderEntityPage({
        name: person.name,
        meta: escapeHtml([person.known_for_department, person.birthday ? `Born ${person.birthday}` : ''].filter(Boolean).join(' · ')),
        bio: person.biography || '',
        imageUrl: person.profile_url || '',
        credits: person.credits || [],
        primaryDept: person.known_for_department,
        follow: {
            is: () => window.api.isFollowingPerson(personId),
            add: () => window.api.followPerson(personId, person.name, person.profile_path),
            remove: () => window.api.unfollowPerson(personId),
        },
    });
}

function formatDateDMY(isoDate) {
    // TMDB dates come as 'YYYY-MM-DD'. Used for plain-text dates (like
    // episode air dates) that aren't going through the custom date-input
    // component, so they still read DD/MM/YYYY consistently.
    if (!isoDate) return '';
    const [y, m, d] = isoDate.split('-');
    if (!y || !m || !d) return isoDate;
    return `${d}/${m}/${y}`;
}

const BADGE_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
function formatBadgeDate(isoDate) {
    // "Feb. 15 2024" style, used on the Last Watched sort — shown as
    // "No date" when a title has no recorded watch date.
    if (!isoDate) return 'No date';
    const [y, m, d] = isoDate.split('-');
    if (!y || !m || !d) return 'No date';
    return `${BADGE_MONTHS[Number(m) - 1]} ${d} ${y}`;
}
function formatBadgeYear(isoDate) {
    // Year-only, used on the Release Date sort — sorting itself still uses
    // the full precise date, this only affects what the badge displays.
    if (!isoDate) return 'No date';
    const year = isoDate.slice(0, 4);
    return year || 'No date';
}
function formatBadgeRating(item) {
    // Used on the Rating sort — same 5-star scale shown elsewhere (rating
    // is stored out of 10). A favorite isn't "no rating" — it's its own
    // rating, beyond the 5-star scale, so it gets its own badge instead of
    // falling back to "Unrated".
    if (!item.rating) return item.is_favorite ? '♥ Favorite' : 'Unrated';
    return `★ ${(item.rating / 2).toFixed(1)}${item.is_favorite ? ' ♥' : ''}`;
}
function ratingBadgeClass(item) {
    // Tiers the bottom poster badge by score when sorted by Rating (rating
    // stored out of 10, compared on the 5-star scale actually shown):
    // 5 cyan, 3.5-4.5 green, 2.5-3 yellow, below that red, unrated gray.
    // Favorites get their own pink tier, ranked above even a perfect 5 stars.
    if (!item.rating) return item.is_favorite ? 'rate-favorite' : 'rate-none';
    const stars5 = item.rating / 2;
    if (stars5 >= 5) return 'rate-cyan';
    if (stars5 >= 3.5) return 'rate-green';
    if (stars5 >= 2.5) return 'rate-yellow';
    return 'rate-red';
}
function dateBadgeFor(item, sortCriterion) {
    // Roulette's "Mark Watched" — no date on file, so say why instead of
    // just "No date". Takes priority over the sort-specific badges below,
    // same as its color/sort-position overrides elsewhere.
    const hasRealDate = Boolean(item.date_finished || item.date_started || item.date_rewatched);
    if (item.queued_at && item.status === 'planned' && item.queued_via !== 'manual') return 'From the Wheel';
    if (item.queued_at && item.status === 'planned') return 'Plan to Watch'; // queued by hand
    if (item.quick_saved && !hasRealDate) return 'From the Wheel';
    // Year-only when sorting by Release Date, rating when sorting by
    // Rating, last-watched date when sorting by that. No badge at all for
    // Alphabetical — that sort has no date/rating dimension to show.
    if (sortCriterion === 'release_date') return formatBadgeYear(item.release_date);
    if (sortCriterion === 'rating') return formatBadgeRating(item);
    if (sortCriterion === 'alphabetical') return '';
    // Falls back to the rewatch date when there's no watch/start date at
    // all — a rewatched-but-never-originally-dated item (like importing an
    // old favorite you rewatched more recently than you first saw it)
    // shouldn't just show "No date" when there's a real date sitting right
    // there on the same entry.
    return formatBadgeDate(item.date_finished || item.date_started || item.date_rewatched);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// ---------------- init ----------------

initAuthGate();


// ---- clone / make public-private ----
document.getElementById('listDetailCloneBtn').addEventListener('click', async () => {
    if (!currentListDetail?.id) return;
    const btn = document.getElementById('listDetailCloneBtn');
    btn.disabled = true;
    try {
        const created = await window.api.cloneList(currentListDetail.id);
        showToast(`Cloned "${currentListDetail.name}" to your lists`);
        currentListDetail.clone_count = (currentListDetail.clone_count || 0) + 1;
        await openListDetail(created.id);
    } catch (err) {
        showToast(`Couldn't clone: ${err.message}`, true);
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('listDetailVisibilityBtn').addEventListener('click', async () => {
    if (!currentListDetail?.id) return;
    const next = (currentListDetail.visibility || 'private') === 'private' ? 'public' : 'private';
    try {
        await window.api.setListVisibility(currentListDetail.id, next);
        currentListDetail.visibility = next;
        showToast(next === 'public' ? 'List is now public' : 'List is now private');
        renderListDetail();
    } catch (err) {
        showToast(`Couldn't update: ${err.message}`, true);
    }
});

// ---- comments (replies one level deep, likes, delete own) ----
let listCommentsCache = [];
let listCommentsFor = null;
let listThreadMuted = false;

async function renderListComments(list, editing) {
    const box = document.getElementById('listComments');
    if (!list.id || editing) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (listCommentsFor !== list.id) { listCommentsCache = []; listCommentsFor = list.id; box.innerHTML = ''; }
    try {
        listCommentsCache = await window.api.listListComments(list.id);
        listThreadMuted = await window.api.isListThreadMuted(list.id).catch(() => false);
    } catch (err) {
        box.innerHTML = `<div class="list-comments-header"><h3>COMMENTS</h3></div><p class="profile-tab-empty">Comments aren't available yet (run list-social-migration.sql).</p>`;
        return;
    }
    if (currentListDetail !== list) return;
    paintListComments(list);
}

function commentAvatarHtml(c) {
    if (c.author_avatar_url) return `<div class="list-comment-avatar" style="background:transparent"><img src="${c.author_avatar_url}" alt=""></div>`;
    const bg = c.author_avatar_color || colorForId(String(c.user_id));
    return `<div class="list-comment-avatar" style="background:${bg}"><span>${escapeHtml((c.author_name || '?').charAt(0).toUpperCase())}</span></div>`;
}

function commentItemHtml(c, list, isReply) {
    const canDelete = c.is_mine || list.isOwner;
    return `
        <div class="list-comment${isReply ? ' list-comment--reply' : ''}" data-comment-id="${c.id}">
            ${commentAvatarHtml(c)}
            <div class="list-comment-main">
                <div class="list-comment-head"><strong>${escapeHtml(c.author_name)}</strong><span class="list-comment-time">${escapeHtml(timeAgo(c.created_at))}</span></div>
                <div class="list-comment-body">${escapeHtml(c.body)}</div>
                <div class="list-comment-actions">
                    <button type="button" class="list-comment-like${c.liked_by_me ? ' liked' : ''}" data-action="like">&#9829; ${c.like_count || ''}</button>
                    <button type="button" data-action="reply" data-name="${escapeHtml(c.author_name)}">Reply</button>
                    ${canDelete ? '<button type="button" data-action="delete">Delete</button>' : ''}
                </div>
                <div class="list-comment-reply-slot"></div>
            </div>
        </div>`;
}

function paintListComments(list) {
    const box = document.getElementById('listComments');
    const tops = listCommentsCache.filter((c) => !c.parent_id);
    const repliesOf = (id) => listCommentsCache.filter((c) => c.parent_id === id);
    const n = listCommentsCache.length;
    box.innerHTML = `
        <div class="list-comments-header">
            <h3>${n ? `${n} COMMENT${n === 1 ? '' : 'S'}` : 'COMMENT?'}</h3>
            <button type="button" id="listCommentsMuteBtn" class="list-comments-mute${listThreadMuted ? ' muted' : ''}">
                ${listThreadMuted ? 'Enable notifications for this thread' : 'Mute notifications for this thread'}
                <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.4-1.8h-4.8A2.5 2.5 0 0 0 12 22zm7-6.5V11a7 7 0 0 0-5-6.7V3.5a2 2 0 0 0-4 0v.8A7 7 0 0 0 5 11v4.5L3 17.5V19h18v-1.5z"/></svg>
            </button>
        </div>
        <div class="list-comment-composer">
            <textarea id="listCommentInput" maxlength="1000" placeholder="Add a comment…"></textarea>
            <button type="button" id="listCommentPostBtn" class="save-btn" style="margin:0;">Post</button>
        </div>
        <div class="list-comments-thread">
            ${tops.map((c) => `
                <div class="list-comment-group">
                    ${commentItemHtml(c, list, false)}
                    ${repliesOf(c.id).map((r) => commentItemHtml(r, list, true)).join('')}
                </div>`).join('')}
        </div>`;

    const refresh = async () => {
        listCommentsCache = await window.api.listListComments(list.id);
        paintListComments(list);
    };
    const post = async (body, parentId, btn) => {
        if (!body.trim()) return;
        btn.disabled = true;
        try {
            await window.api.addListComment(list.id, body, parentId);
            await refresh();
        } catch (err) {
            showToast(`Couldn't post: ${err.message}`, true);
            btn.disabled = false;
        }
    };
    document.getElementById('listCommentsMuteBtn').addEventListener('click', async () => {
        try {
            listThreadMuted = await window.api.toggleListThreadMute(list.id);
            showToast(listThreadMuted ? 'Notifications muted for this thread' : 'Notifications enabled for this thread');
            paintListComments(list);
        } catch (err) {
            showToast(`Couldn't update: ${err.message}`, true);
        }
    });
    const mainBtn = document.getElementById('listCommentPostBtn');
    mainBtn.addEventListener('click', () => post(document.getElementById('listCommentInput').value, null, mainBtn));

    box.querySelectorAll('.list-comment').forEach((el) => {
        const id = Number(el.dataset.commentId);
        const c = listCommentsCache.find((x) => x.id === id);
        el.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            try {
                if (action === 'like') { await window.api.toggleListCommentLike(id); await refresh(); }
                else if (action === 'delete') {
                    const ok = await showConfirm('Delete this comment?', { confirmLabel: 'Delete' });
                    if (ok) { await window.api.deleteListComment(id); await refresh(); }
                } else if (action === 'reply') {
                    const slot = el.querySelector('.list-comment-reply-slot');
                    if (slot.innerHTML) { slot.innerHTML = ''; return; }
                    // Replies always hang off the top-level comment of the thread.
                    const parentId = c.parent_id || c.id;
                    const prefill = c.parent_id ? `@${c.author_name} ` : '';
                    slot.innerHTML = `
                        <div class="list-comment-composer list-comment-composer--reply">
                            <textarea maxlength="1000" placeholder="Reply to ${escapeHtml(c.author_name)}…"></textarea>
                            <button type="button" class="save-btn" style="margin:0;">Reply</button>
                        </div>`;
                    const ta = slot.querySelector('textarea');
                    ta.value = prefill;
                    ta.focus();
                    ta.setSelectionRange(ta.value.length, ta.value.length);
                    const rb = slot.querySelector('button');
                    rb.addEventListener('click', () => post(ta.value, parentId, rb));
                }
            } catch (err) {
                showToast(`Couldn't update: ${err.message}`, true);
            }
        }));
    });
}

document.getElementById('listShareCopyBtn').addEventListener('click', async () => {
    const val = document.getElementById('listShareLinkInput').value;
    if (!val) return;
    try { await navigator.clipboard.writeText(val); showToast('Link copied'); }
    catch { showToast("Couldn't copy the link", true); }
});
document.getElementById('listShareFamilyBtn').addEventListener('click', () => {
    document.getElementById('listDetailShareBtn').click();
});


// ==================== PROFILE STATS (one view per media type) ====================
// Step 1: the framework + headline numbers. Each media type gets its own
// title and its own set of numbers; the sections below the header (by year,
// decades, genres, …) are added one at a time.

const STATS_VIEWS = {
    movie: { label: 'Cinema', title: 'My Cinema', unit: 'Films' },
    tv: { label: 'Television', title: 'My Television', unit: 'Series' },
    book: { label: 'Literature', title: 'My Library', unit: 'Books' },
    game: { label: 'Videogames', title: 'My Videogames', unit: 'Games' },
};
let statsMedia = 'movie';
// Plural / singular noun for the current stats view (films / series / books / games).
const STATS_NOUN = { movie: ['film', 'films'], tv: ['series', 'series'], book: ['book', 'books'], game: ['game', 'games'] };
const statsNoun = (n = 2) => (STATS_NOUN[statsMedia] || STATS_NOUN.movie)[n === 1 ? 0 : 1];
const statsFacets = {}; // media_id -> { countries, languages, directors }
let statsYear = 'all';

function statsDayOf(e) {
    return (e.date_rewatched || e.date_finished || '').slice(0, 10);
}
function statsLongestStreak(days) {
    const uniq = [...new Set(days)].sort();
    let best = 0, run = 0, prev = null;
    for (const d of uniq) {
        const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
        run = prev !== null && t - prev === 86400000 ? run + 1 : 1;
        best = Math.max(best, run);
        prev = t;
    }
    return best;
}
function statsNumber(n) { return Number(n).toLocaleString('en-US'); }

function computeStatsHeadline(type, items, allDays, facets = {}) {
    if (type === 'movie') {
        const minutes = items.reduce((t, e) => t + (e.runtime || 0), 0);
        const perDay = {};
        allDays.forEach((d) => { perDay[d] = (perDay[d] || 0) + 1; });
        return [
            { num: statsNumber(items.length), label: 'Films' },
            { num: statsNumber(Math.round(minutes / 60)), label: 'Hours' },
            ...(Object.keys(facets).length ? [
                { num: statsNumber(new Set(items.flatMap((e) => facets[e.media_id]?.directors || [])).size), label: 'Directors' },
                { num: statsNumber(new Set(items.flatMap((e) => facets[e.media_id]?.countries || [])).size), label: 'Countries' },
            ] : []),
            { num: `${statsLongestStreak(allDays)}d`, label: 'Longest Streak' },
            { num: statsNumber(Object.values(perDay).filter((c) => c >= 2).length), label: '2+ Film Days' },
        ];
    }
    if (type === 'book' || type === 'game') {
        const noun = type === 'book' ? 'Books' : 'Games';
        const authors = Object.keys(facets).length
            ? [{ num: statsNumber(new Set(items.flatMap((e) => facets[e.media_id]?.directors || [])).size), label: type === 'book' ? 'Authors' : 'Developers' }] : [];
        const rated = items.filter((e) => e.rating);
        return [
            { num: statsNumber(items.length), label: noun },
            ...authors,
            { num: rated.length ? (rated.reduce((t, e) => t + e.rating, 0) / rated.length / 2).toFixed(1) : '—', label: 'Avg Rating' },
            { num: `${statsLongestStreak(allDays)}d`, label: 'Longest Streak' },
            { num: `${statsCurrentStreak(allDays)}d`, label: 'Current Streak' },
        ];
    }
    // Television: whole series count, plus what you actually watched (from the per-episode log).
    const log = facets.__tvLog || null;
    if (log && log.length) {
        const byEntry = Object.fromEntries(items.map((e) => [e.id, e]));
        const runtimeOf = (entryId) => (profileAllEntries.find((e) => e.id === entryId)?.runtime) || 40;
        const days = log.map((r) => r.day).filter(Boolean);
        const minutes = log.reduce((t, r) => t + runtimeOf(r.entry_id), 0);
        const seasons = items.reduce((t, e) => t + (e.number_of_seasons || 0), 0);
        return [
            { num: statsNumber(items.length), label: 'Series' },
            { num: statsNumber(log.length), label: 'Episodes' },
            { num: statsNumber(Math.round(minutes / 60)), label: 'Hours' },
            { num: `${statsLongestStreak(days)}d`, label: 'Longest Streak' },
            { num: `${statsCurrentStreak(days)}d`, label: 'Current Streak' },
            { num: statsNumber(seasons), label: 'Seasons' },
        ];
    }
    const episodes = items.reduce((t, e) => t + (e.number_of_episodes || 0), 0);
    const minutes = items.reduce((t, e) => t + (e.number_of_episodes || 0) * (e.runtime || 40), 0);
    const seasons = items.reduce((t, e) => t + (e.number_of_seasons || 0), 0);
    return [
        { num: statsNumber(items.length), label: 'Series' },
        { num: statsNumber(episodes), label: 'Episodes' },
        { num: statsNumber(Math.round(minutes / 60)), label: 'Hours' },
        { num: statsNumber(seasons), label: 'Seasons' },
    ];
}

function statsCurrentStreak(days) {
    const set = new Set(days);
    const iso = (d) => d.toISOString().slice(0, 10);
    const cur = new Date();
    if (!set.has(iso(cur))) cur.setDate(cur.getDate() - 1); // today not logged yet — streak can still be alive from yesterday
    let n = 0;
    while (set.has(iso(cur))) { n++; cur.setDate(cur.getDate() - 1); }
    return n;
}

let statsTvLog = { version: -1, rows: null };
let statsLogCounts = { version: -1, map: {} };

let statsRenderSeq = 0;
function renderProfileStats(container, entries) {
    // A slower, earlier render (e.g. Television still loading) must never paint over a newer one (Literature).
    const mySeq = ++statsRenderSeq;
    const view = STATS_VIEWS[statsMedia];
    const name = (profileEls.nameDisplay.textContent || '').trim() || 'Your';
    const avatarHtml = profileAvatarUrl
        ? `<img src="${profileAvatarUrl}" alt="">`
        : `<span>${escapeHtml(name.charAt(0).toUpperCase())}</span>`;

    container.innerHTML = `
        <div class="stats-switcher">
            ${Object.entries(STATS_VIEWS).map(([k, v]) =>
                `<button type="button" class="stats-switch-btn${k === statsMedia ? ' active' : ''}${v.soon ? ' soon' : ''}" data-media="${k}"${v.soon ? ' disabled' : ''}>${v.label}${v.soon ? ' <em>soon</em>' : ''}</button>`).join('')}
        </div>
        <div class="stats-hero">
            <div class="stats-hero-top">
                <h2 class="stats-hero-title">${view.title}</h2>
                <div id="statsYearSelect" class="stats-year-select"></div>
            </div>
            <div class="stats-hero-sub">
                <span class="stats-hero-avatar" style="background:${profileSelectedColor || '#888'}">${avatarHtml}</span>
                <span id="statsHeroSubText"></span>
            </div>
            <div id="statsHeadline" class="stats-headline"></div>
        </div>
        <div id="statsSections"></div>
    `;
    container.querySelectorAll('.stats-switch-btn:not(.soon)').forEach((b) => b.addEventListener('click', () => {
        statsMedia = b.dataset.media;
        statsYear = 'all';
        renderProfileStats(container, entries);
    }));

    const ofType = entries.filter((e) => e.media_type === statsMedia && profileFinished(e));
    const years = [...new Set(ofType.map((e) => statsDayOf(e).slice(0, 4)).filter(Boolean))].sort().reverse();
    createCustomSelect({
        container: document.getElementById('statsYearSelect'),
        options: [{ value: 'all', label: 'All time' }, ...years.map((y) => ({ value: y, label: y }))],
        value: statsYear,
        onChange: (v) => { statsYear = v; paintStats(); },
    });

    function paintStats() {
        if (mySeq !== statsRenderSeq || !document.getElementById('statsHeadline')) return;
        const inYear = statsYear === 'all' ? ofType : ofType.filter((e) => statsDayOf(e).startsWith(statsYear));
        document.getElementById('statsHeroSubText').textContent =
            `${name}'s ${statsYear === 'all' ? 'all-time' : statsYear} stats`;
        const days = inYear.map(statsDayOf).filter(Boolean);
        const yearLog = statsMedia === 'tv' && statsTvLog.rows
            ? statsTvLog.rows.filter((r) => r.day && (statsYear === 'all' || r.day.startsWith(statsYear))) : null;
        document.getElementById('statsHeadline').innerHTML = computeStatsHeadline(statsMedia, inYear, days, yearLog ? { ...statsFacets, __tvLog: yearLog } : statsFacets)
            .map((s) => `<div class="stats-headline-item"><div class="stats-headline-num">${s.num}</div><div class="stats-headline-label">${s.label}</div></div>`).join('');
        const host = document.getElementById('statsSections');
        host.innerHTML = '<div id="statsByYear" class="stats-section"></div><div id="statsDecades" class="stats-section"></div><div id="statsFacets" class="stats-section"></div><div id="statsListProgress" class="stats-section"></div><div id="statsCollections" class="stats-section"></div><div id="statsMostWatched" class="stats-section"></div><div id="statsHigher" class="stats-section"></div><div id="statsLower" class="stats-section"></div><div id="statsCast" class="stats-section"></div><div id="statsDirectors" class="stats-section"></div><div id="statsStudios" class="stats-section"></div><div id="statsCrew" class="stats-section"></div><div id="statsMap" class="stats-section"></div>';
        paintStatsByYear(host, inYear);
        paintStatsDecades(document.getElementById('statsDecades'), inYear);
        paintStatsFacets(document.getElementById('statsFacets'), inYear);
        paintStatsListProgress(document.getElementById('statsListProgress'), ofType.filter((e) => profileFinished(e)));
        paintStatsCollections(document.getElementById('statsCollections'), ofType);
        paintStatsMostWatched(document.getElementById('statsMostWatched'), inYear);
        paintStatsVsAverage(document.getElementById('statsHigher'), inYear, 'higher');
        paintStatsVsAverage(document.getElementById('statsLower'), inYear, 'lower');
        const people = statsMedia === 'movie' || statsMedia === 'tv';
        const keep = statsMedia === 'book' ? ['statsDirectors', 'statsStudios', 'statsMap'] : statsMedia === 'game' ? ['statsDirectors', 'statsStudios'] : [];
        ['statsCast', 'statsDirectors', 'statsStudios', 'statsCrew', 'statsMap'].forEach((id) => { if (!people && !keep.includes(id)) document.getElementById(id)?.remove(); });
        if (statsMedia === 'book') paintStatsMap(document.getElementById('statsMap'), inYear);
        if (statsMedia === 'book' || statsMedia === 'game') {
            paintStatsPeople(document.getElementById('statsDirectors'), inYear, 'directors');
            paintStatsPeople(document.getElementById('statsStudios'), inYear, 'studios');
        }
        if (people) {
            paintStatsPeople(document.getElementById('statsCast'), inYear, 'cast');
            paintStatsPeople(document.getElementById('statsDirectors'), inYear, 'directors');
            paintStatsPeople(document.getElementById('statsStudios'), inYear, 'studios');
            paintStatsCrew(document.getElementById('statsCrew'), inYear);
            paintStatsMap(document.getElementById('statsMap'), inYear);
        }
    }
    // Everything the headline needs (directors/countries, the TV watch log) is fetched BEFORE the
    // first paint, so the numbers appear once instead of rearranging a moment later.
    const missing = [...new Set(ofType.map((e) => e.media_id).filter((id) => id && !statsFacets[id]))];
    const needLog = statsMedia === 'tv' && statsTvLog.version !== entriesCacheVersion;
    const needCounts = statsLogCounts.version !== entriesCacheVersion;
    if (missing.length || needLog || needCounts) {
        document.getElementById('statsSections').innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading stats…</p></div>';
        const jobs = [];
        if (missing.length) jobs.push(window.api.getStatsFacets(missing).then((f) => { Object.assign(statsFacets, f || {}); }).catch((err) => console.error('stats facets failed:', err)));
        if (needLog) jobs.push(window.api.getTvWatchLog().then((rows) => { statsTvLog = { version: entriesCacheVersion, rows }; }).catch((err) => { console.error('tv log failed:', err); statsTvLog = { version: entriesCacheVersion, rows: null }; }));
        if (needCounts) jobs.push(window.api.getStatsLogCounts().then((m) => { statsLogCounts = { version: entriesCacheVersion, map: m || {} }; }).catch(() => { statsLogCounts = { version: entriesCacheVersion, map: {} }; }));
        Promise.all(jobs).then(() => { if (document.getElementById('statsHeadline')) paintStats(); });
    } else {
        paintStats();
    }
}


// ---- Section: By Year (Films / Ratings / Diary) ----
let statsByYearTab = 'films';

function statsLerpColor(a, b, t) {
    const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
    const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
    return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
}

// bars: [{ label, value, tip, sub }] — value 0 draws a flat dashed stub.
function statsBarChartHtml(bars, max, colorFor) {
    return `
        <div class="stats-bars">
            ${bars.map((b, i) => `<div class="stats-bar-slot${b.year ? ' clickable' : ''}" data-tip="${escapeHtml(b.tip)}" data-sub="${escapeHtml(b.sub)}"${b.year ? ` data-year="${b.year}"` : ''}>
                ${b.value > 0
                    ? `<div class="stats-bar" style="height:${Math.max(2, (b.value / max) * 100)}%;background:${colorFor(i, bars.length)}"></div>`
                    : '<div class="stats-bar-empty"></div>'}
            </div>`).join('')}
        </div>
        <div class="stats-bars-axis"><span>${escapeHtml(bars[0].label)}</span><span>${escapeHtml(bars[bars.length - 1].label)}</span></div>`;
}

function paintStatsByYear(host, items) {
    let section = host.querySelector('#statsByYear');
    if (!section) {
        host.innerHTML = '<div id="statsByYear" class="stats-section"></div>';
        section = host.querySelector('#statsByYear');
    }
    const unit = statsNoun(2);
    const tabs = [['films', statsNoun(2).toUpperCase()], ['ratings', 'RATINGS'], ['diary', 'DIARY']];
    section.innerHTML = `
        <div class="stats-section-head">
            <h3>BY YEAR</h3><span class="stats-section-line"></span>
            <div class="stats-section-tabs">
                ${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${k === statsByYearTab ? 'active' : ''}">${l}</button>`).join('')}
            </div>
        </div>
        <div id="statsByYearChart" class="stats-chart"></div>
        <div id="statsTip" class="stats-tip hidden"></div>`;
    section.querySelectorAll('.stats-section-tabs button').forEach((b) => b.addEventListener('click', () => {
        statsByYearTab = b.dataset.tab;
        paintStatsByYear(host, items);
    }));

    const chart = section.querySelector('#statsByYearChart');
    const releaseYear = (e) => Number((e.release_date || '').slice(0, 4)) || null;
    let html = '';

    if (statsByYearTab === 'diary') {
        // All time → one bar per year logged; a single year → one bar per month.
        let bars;
        if (statsYear === 'all') {
            const counts = {};
            items.forEach((e) => { const y = statsDayOf(e).slice(0, 4); if (y) counts[y] = (counts[y] || 0) + 1; });
            const ys = Object.keys(counts).map(Number);
            if (ys.length) {
                const lo = Math.min(...ys), hi = Math.max(...ys);
                bars = Array.from({ length: hi - lo + 1 }, (_, i) => ({ label: String(lo + i), value: counts[lo + i] || 0,
                    tip: `${counts[lo + i] || 0} ${unit}`, sub: `Logged in ${lo + i}` }));
            }
        } else {
            const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const counts = Array(12).fill(0);
            items.forEach((e) => { const m = Number(statsDayOf(e).slice(5, 7)); if (m) counts[m - 1]++; });
            bars = counts.map((c, i) => ({ label: names[i], value: c, tip: `${c} ${unit}`, sub: `Logged in ${names[i]} ${statsYear}` }));
        }
        html = bars ? statsBarChartHtml(bars, Math.max(...bars.map((b) => b.value), 1), (i, n) => statsLerpColor('00e054', '40ff90', i / Math.max(1, n - 1)))
                    : '<p class="stats-empty">Nothing logged yet.</p>';
    } else {
        const withYear = items.filter(releaseYear);
        if (!withYear.length) {
            html = '<p class="stats-empty">Nothing to chart yet.</p>';
        } else {
            const lo = Math.min(...withYear.map(releaseYear)), hi = Math.max(new Date().getFullYear(), ...withYear.map(releaseYear));
            const byYear = {};
            withYear.forEach((e) => { (byYear[releaseYear(e)] ||= []).push(e); });
            if (statsByYearTab === 'films') {
                const bars = Array.from({ length: hi - lo + 1 }, (_, i) => { const y = lo + i; const c = (byYear[y] || []).length;
                    return { label: String(y), value: c, tip: `${c} ${c === 1 ? unit.replace(/s$/, '') : unit}`, sub: `Premiered in ${y}`, year: c ? y : 0 }; });
                html = statsBarChartHtml(bars, Math.max(...bars.map((b) => b.value), 1), (i, n) => statsLerpColor('00e054', '40bcf4', i / Math.max(1, n - 1)));
            } else {
                const bars = Array.from({ length: hi - lo + 1 }, (_, i) => { const y = lo + i;
                    const rated = (byYear[y] || []).filter((e) => e.rating);
                    const avg = rated.length ? rated.reduce((t, e) => t + e.rating, 0) / rated.length / 2 : 0; // stored /10 → 5-star scale
                    return { label: String(y), value: avg, tip: `Average ${avg.toFixed(2)}`, sub: `Premiered in ${y}`, year: (byYear[y] || []).length ? y : 0 }; });
                html = statsBarChartHtml(bars, 5, (i, n) => statsLerpColor('ffb347', 'ffe066', i / Math.max(1, n - 1)));
            }
        }
    }
    chart.innerHTML = html;

    const tip = section.querySelector('#statsTip');
    chart.querySelectorAll('.stats-bar-slot').forEach((slot) => {
        slot.addEventListener('mouseenter', () => {
            tip.innerHTML = `<strong>${slot.dataset.tip}</strong><span>${slot.dataset.sub}</span>`;
            tip.classList.remove('hidden');
            const r = slot.getBoundingClientRect(), p = section.getBoundingClientRect();
            tip.style.left = `${Math.min(Math.max(r.left - p.left + r.width / 2, 70), p.width - 70)}px`;
            tip.style.top = `${r.top - p.top + chart.offsetTop - 0}px`;
        });
        slot.addEventListener('mouseleave', () => tip.classList.add('hidden'));
        if (slot.dataset.year) slot.addEventListener('click', () => openStatsFilter({ kind: 'Year', value: Number(slot.dataset.year), label: slot.dataset.year, media: statsMedia }));
    });
}



// ---- Section: Highest Rated Decades ----
// Decades ranked by average rating (5-star scale), each showing its
// best-rated titles. A decade needs a few rated titles to count, so one lucky
// 5-star doesn't win.
function paintStatsDecades(section, items) {
    const MIN_RATED = 3, SHOW_DECADES = 3, POSTERS = 20;
    const byDecade = {};
    items.filter((e) => e.rating).forEach((e) => {
        const d = decadeOf(e.release_date);
        if (d != null) (byDecade[d] ||= []).push(e);
    });
    const decades = Object.entries(byDecade)
        .filter(([, list]) => list.length >= MIN_RATED)
        .map(([d, list]) => ({ decade: Number(d), list, avg: list.reduce((t, e) => t + e.rating, 0) / list.length / 2 }))
        .sort((a, b) => b.avg - a.avg)
        .slice(0, SHOW_DECADES);

    section.innerHTML = `
        <div class="stats-section-head"><h3>HIGHEST RATED DECADES</h3><span class="stats-section-line"></span></div>
        ${decades.length ? decades.map((d) => `
            <div class="stats-decade">
                <div class="stats-decade-info">
                    <div class="stats-decade-name clickable" data-decade="${d.decade}">${d.decade}s</div>
                    <div class="stats-decade-avg">&#9733; Average ${d.avg.toFixed(2)}</div>
                </div>
                <div class="stats-decade-posters">
                    ${[...d.list].sort((a, b) => b.rating - a.rating || a.title.localeCompare(b.title)).slice(0, POSTERS).map((e) => `
                        <div class="stats-decade-item" data-tmdb-id="${e.tmdb_id}" data-media-type="${e.media_type}" title="${escapeHtml(e.title)}${e.release_date ? ` (${e.release_date.slice(0, 4)})` : ''}">
                            <img class="stats-decade-poster" src="${e.poster_url || (e.poster_path ? imgSrc(e.poster_path) : '')}"
                                 alt="${escapeHtml(e.title)}" loading="lazy">
                            <div class="poster-date-badge ${ratingBadgeClass(e)}">${escapeHtml(formatBadgeRating(e))}</div>
                        </div>`).join('')}
                </div>
            </div>`).join('') : `<p class="stats-empty">Rate at least ${MIN_RATED} titles from the same decade to see this.</p>`}
    `;
    section.querySelectorAll('.stats-decade-name[data-decade]').forEach((el) => el.addEventListener('click', () =>
        openStatsFilter({ kind: 'Decade', value: Number(el.dataset.decade), label: `${el.dataset.decade}s`, media: statsMedia })));
    section.querySelectorAll('.stats-decade-item').forEach((el) => el.addEventListener('click', () =>
        openDetails(Number(el.dataset.tmdbId), el.dataset.mediaType)));
}


// ---- Section: Genres, Countries & Languages ----
let statsFacetsTab = 'watched';
const STATS_COUNTRY_SHORT = { 'United States of America': 'USA', 'United Kingdom': 'UK', 'Soviet Union': 'USSR', 'United States': 'USA', US: 'USA', GB: 'UK' };

function statsLanguageName(code) {
    if (!code) return null;
    if (code === 'xx') return 'No spoken language';
    if (code === 'cn') return 'Cantonese';
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}

function paintStatsFacets(section, items) {
    const MIN_RATED = 4, ROWS = 10;
    const genreOf = (e) => { try { return JSON.parse(e.genres || '[]'); } catch { return []; } };
    const buildColumn = (keysOf) => {
        const groups = {};
        items.forEach((e) => keysOf(e).forEach((k) => { (groups[k] ||= []).push(e); }));
        return Object.entries(groups).map(([name, list]) => {
            const rated = list.filter((e) => e.rating);
            return { name, count: list.length, ratedCount: rated.length,
                avg: rated.length ? rated.reduce((t, e) => t + e.rating, 0) / rated.length / 2 : 0 };
        });
    };
    const columns = [
        { title: 'Genres', color: '#00e054', rows: buildColumn(genreOf) },
        { title: 'Countries', color: '#40bcf4', rows: buildColumn((e) => (statsFacets[e.media_id]?.countries || []).map((c) => STATS_COUNTRY_SHORT[c] || c)) },
        { title: 'Languages', color: '#ff8000', rows: buildColumn((e) => (statsFacets[e.media_id]?.languages || []).map(statsLanguageName).filter(Boolean)) },
    ];
    // Countries / languages only exist for film & TV data.
    if (statsMedia === 'game') columns.splice(1);
    else if (statsMedia === 'book') { columns.splice(2); columns[1].title = 'Author Countries'; }
    const facetsLoaded = items.some((e) => statsFacets[e.media_id]);

    const colHtml = (c) => {
        let rows;
        if (statsFacetsTab === 'watched') {
            rows = [...c.rows].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, ROWS)
                .map((r) => ({ name: r.name, frac: r.count / Math.max(1, ...c.rows.map((x) => x.count)),
                    tip: `${statsNumber(r.count)} ${statsNoun(r.count)}` }));
        } else {
            rows = c.rows.filter((r) => r.ratedCount >= MIN_RATED).sort((a, b) => b.avg - a.avg).slice(0, ROWS)
                .map((r) => ({ name: r.name, frac: r.avg / 5, tip: `Average ${r.avg.toFixed(2)}` }));
        }
        if (!rows.length) return `<div class="stats-facet-col"><p class="stats-empty" style="padding:1rem 0;text-align:left;">${
            c.title !== 'Genres' && !facetsLoaded ? 'Loading…' : 'Nothing yet'}</p></div>`;
        return `<div class="stats-facet-col">${rows.map((r, i) => {
            const t = rows.length > 1 ? i / (rows.length - 1) : 0;
            return `<div class="stats-facet-row" data-kind="${c.title}" data-name="${escapeHtml(r.name)}" title="${escapeHtml(r.name)} — ${r.tip}">
                <span class="stats-facet-name">${escapeHtml(r.name)}</span>
                <span class="stats-facet-barwrap"><span class="stats-facet-bar" style="width:${Math.max(3, r.frac * 100)}%;background:${statsLerpColor(c.color.slice(1), 'ffffff', t * 0.35)}">${escapeHtml(r.tip)}</span></span>
            </div>`;
        }).join('')}</div>`;
    };

    section.innerHTML = `
        <div class="stats-section-head">
            <h3>GENRES, COUNTRIES &amp; LANGUAGES</h3><span class="stats-section-line"></span>
            <div class="stats-section-tabs">
                <button type="button" data-tab="watched" class="${statsFacetsTab === 'watched' ? 'active' : ''}">MOST WATCHED</button>
                <button type="button" data-tab="rated" class="${statsFacetsTab === 'rated' ? 'active' : ''}">HIGHEST RATED</button>
            </div>
        </div>
        <div class="stats-facet-grid">${columns.map(colHtml).join('')}</div>
        ${statsFacetsTab === 'rated' ? `<p class="stats-footnote">Genres, countries and languages with at least ${MIN_RATED} rated titles are included.</p>` : ''}
    `;
    section.querySelectorAll('.stats-facet-row').forEach((row) => row.addEventListener('click', () =>
        openStatsFilter({ kind: row.dataset.kind, value: row.dataset.name, label: row.dataset.name, media: statsMedia })));
    section.querySelectorAll('.stats-section-tabs button').forEach((b) => b.addEventListener('click', () => {
        statsFacetsTab = b.dataset.tab;
        paintStatsFacets(section, items);
    }));
}



// ---- Sections after Collections: most watched, vs. average, people, studios, crew, map ----
const statsMore = {};   // section key -> expanded?
const statsTabs = {};   // section key -> 'watched' | 'rated'
const STATS_MIN_RATED_PEOPLE = 3;
const statsVerb = () => ({ movie: 'watched', tv: 'watched', book: 'read', game: 'played' }[statsMedia] || 'watched');
const statsUnitWord = (n) => statsNoun(n);
const statsPosterSrc = (e) => e.poster_url || (e.poster_path ? imgSrc(e.poster_path) : '');

function statsPosterGrid(section, key, title, rows, emptyMsg, rerender) {
    const open = statsMore[key];
    // columns that fit in this section (160px posters, 20px gaps) so every row is filled before "Show more"
    const cols = Math.max(1, Math.floor((Math.max(section.clientWidth, 640) - 56 + 20) / 180));
    const LIMIT = cols * 2;
    const total = Math.min(rows.length, 60);
    const shown = open ? rows.slice(0, total) : rows.slice(0, LIMIT);
    section.innerHTML = `
        <div class="stats-section-head"><h3>${title}</h3><span class="stats-section-line"></span></div>
        ${rows.length ? `<div class="poster-grid stats-poster-grid">${shown.map((r) => `
            <div class="poster-card" data-tmdb-id="${r.e.tmdb_id}" data-media-type="${r.e.media_type}">
                <div class="poster-img-wrap">
                    <img src="${statsPosterSrc(r.e)}" alt="${escapeHtml(r.e.title)}" loading="lazy" onerror="this.style.opacity=0.3">
                    <div class="poster-date-badge ${r.cls}">${escapeHtml(r.label)}</div>
                    <div class="film-card-overlay"><div class="film-card-title">${escapeHtml(r.e.title)}${r.e.release_date ? ` (${r.e.release_date.slice(0, 4)})` : ''}</div></div>
                </div>
            </div>`).join('')}</div>
            ${rows.length > LIMIT ? `<div class="stats-more-wrap"><button type="button" class="stats-show-all">${open ? 'Show less' : 'Show more'}</button></div>` : ''}`
            : `<p class="stats-empty">${emptyMsg}</p>`}`;
    section.querySelectorAll('.poster-card').forEach((el) => el.addEventListener('click', () => openDetails(Number(el.dataset.tmdbId), el.dataset.mediaType)));
    section.querySelector('.stats-show-all')?.addEventListener('click', () => { statsMore[key] = !open; rerender(); });
}

function paintStatsMostWatched(section, items) {
    const rows = items.map((e) => ({ e, n: Math.max(statsLogCounts.map[e.id] || 0, e.status === 'rewatched' ? 2 : 1) }))
        .filter((x) => x.n >= 2).sort((a, b) => b.n - a.n || a.e.title.localeCompare(b.e.title))
        .map((x) => ({ e: x.e, label: `${x.n} times`, cls: 'status-pill--rewatched' }));
    statsPosterGrid(section, 'mostWatched', `MOST ${statsVerb().toUpperCase()}`, rows,
        `Log a title more than once to see your most ${statsVerb()} here.`, () => paintStatsMostWatched(section, items));
}

function paintStatsVsAverage(section, items, dir) {
    const rated = items.filter((e) => e.rating && Number(e.tmdb_vote_average) > 0)
        .map((e) => ({ e, you: e.rating, avg: Number(e.tmdb_vote_average) / 2, d: e.rating / 2 - Number(e.tmdb_vote_average) / 2 }));
    const byGap = (a, b) => Math.abs(b.d) - Math.abs(a.d) || b.you - a.you || a.e.title.localeCompare(b.e.title);
    const rows = (dir === 'higher' ? rated.filter((x) => x.d >= 0.15).sort(byGap) : rated.filter((x) => x.d <= -0.15).sort(byGap))
        .map((x) => ({ e: x.e, label: `★ ${(x.you / 2).toFixed(1)} vs ${x.avg.toFixed(1)}`, cls: dir === 'higher' ? 'rate-green' : 'rate-red' }));
    statsPosterGrid(section, `vs-${dir}`, `RATED ${dir === 'higher' ? 'HIGHER' : 'LOWER'} THAN AVERAGE`, rows,
        'Rate a few titles to compare with the average.', () => paintStatsVsAverage(section, items, dir));
}

// Collect people/studios per id from the cached facets of every title in the list.
function statsAggregate(items, listOf) {
    const groups = {};
    items.forEach((e) => {
        const f = statsFacets[e.media_id];
        if (!f) return;
        const seen = new Set();
        (listOf(f) || []).forEach((p) => {
            const id = p[0];
            if (seen.has(id)) return;
            seen.add(id);
            const g = groups[id] || (groups[id] = { id, name: p[1], img: p[2] || null, count: 0, ratings: [] });
            g.count += 1;
            if (e.rating) g.ratings.push(e.rating);
        });
    });
    return Object.values(groups).map((g) => ({ ...g, avg: g.ratings.length ? g.ratings.reduce((a, b) => a + b, 0) / g.ratings.length / 2 : 0 }));
}
const statsSortBy = (list, tab) => tab === 'rated'
    ? list.filter((g) => g.ratings.length >= STATS_MIN_RATED_PEOPLE).sort((a, b) => b.avg - a.avg || b.count - a.count || a.name.localeCompare(b.name))
    : [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

function statsTabsHtml(key) {
    const tab = statsTabs[key] || 'watched';
    return `<div class="stats-section-tabs">
        <button type="button" data-tab="watched" class="${tab === 'watched' ? 'active' : ''}">MOST ${statsVerb().toUpperCase()}</button>
        <button type="button" data-tab="rated" class="${tab === 'rated' ? 'active' : ''}">HIGHEST RATED</button></div>`;
}

function paintStatsPeople(section, items, kind) {
    const cfg = {
        cast: { title: 'CAST', listOf: (f) => f.cast, open: (id) => openPerson(id) },
        directors: { title: statsMedia === 'book' ? 'AUTHORS' : statsMedia === 'game' ? 'DEVELOPERS' : 'DIRECTORS', listOf: (f) => f.dirs, open: (id) => (statsMedia === 'game' ? openStudio('developer', id) : openPerson(id)) },
        studios: { title: statsMedia === 'book' ? 'PUBLISHERS' : statsMedia === 'game' ? 'PUBLISHERS' : 'STUDIOS', listOf: (f) => f.studios, open: (id) => statsMedia === 'game' ? openStudio('gpublisher', id) : openStudio(statsMedia === 'book' ? 'publisher' : 'company', id) },
    }[kind];
    const tab = statsTabs[kind] || 'watched';
    const loaded = items.some((e) => statsFacets[e.media_id]);
    const all = statsSortBy(statsAggregate(items, cfg.listOf), tab);
    const expanded = statsMore[kind];
    const shown = all.slice(0, expanded ? 30 : 10);
    const img = (g) => !g.img ? `<span>${escapeHtml(g.name.charAt(0))}</span>` : `<img src="https://image.tmdb.org/t/p/${kind === 'studios' ? 'w185' : 'w185'}${g.img}" alt="" loading="lazy">`;
    section.innerHTML = `
        <div class="stats-section-head"><h3>${cfg.title}</h3><span class="stats-section-line"></span>${statsTabsHtml(kind)}</div>
        ${shown.length ? `<div class="stats-people-grid">${shown.map((g) => `
            <div class="stats-person" data-id="${g.id}">
                <div class="stats-person-img${kind === 'studios' ? ' studio' : ''}">${img(g)}</div>
                <div class="stats-person-name">${escapeHtml(g.name)}</div>
                <div class="stats-person-sub">${tab === 'rated' ? `&#9733; ${g.avg.toFixed(1)}` : `${g.count} ${statsUnitWord(g.count)}`}</div>
            </div>`).join('')}</div>
            ${all.length > 10 ? `<div class="stats-more-wrap"><button type="button" class="stats-show-all">${expanded ? 'Show less' : 'Show more'}</button></div>` : ''}`
            : `<p class="stats-empty">${!loaded ? 'Loading…' : tab === 'rated' ? `Rate at least ${STATS_MIN_RATED_PEOPLE} titles with the same one to see this.` : 'Nothing yet'}</p>`}`;
    section.querySelectorAll('.stats-section-tabs button').forEach((b) => b.addEventListener('click', () => { statsTabs[kind] = b.dataset.tab; paintStatsPeople(section, items, kind); }));
    section.querySelectorAll('.stats-person').forEach((el) => el.addEventListener('click', () => cfg.open(Number(el.dataset.id))));
    section.querySelector('.stats-show-all')?.addEventListener('click', () => { statsMore[kind] = !expanded; paintStatsPeople(section, items, kind); });
}

function paintStatsCrew(section, items) {
    const CATS = [['producers', 'Producers'], ['execs', 'Exec. Producers'], ['writers', 'Writers'], ['editors', 'Editors'],
        ['cinematography', 'Cinematography'], ['composers', 'Composers'], ['design', 'Production Design'], ['costume', 'Costume Design'], ['casting', 'Casting']];
    const tab = statsTabs.crew || 'watched';
    const loaded = items.some((e) => statsFacets[e.media_id]);
    const cols = CATS.map(([key, label]) => ({ label, rows: statsSortBy(statsAggregate(items, (f) => f.crew && f.crew[key]), tab).slice(0, 5) })).filter((c) => c.rows.length);
    section.innerHTML = `
        <div class="stats-section-head"><h3>CREW</h3><span class="stats-section-line"></span>${statsTabsHtml('crew')}</div>
        ${cols.length ? `<div class="stats-crew-grid">${cols.map((c) => `
            <div class="stats-crew-col"><div class="stats-crew-title">${c.label}</div>
                ${c.rows.map((g) => `<div class="stats-crew-row" data-id="${g.id}"><span class="stats-crew-name">${escapeHtml(g.name)}</span> <span class="stats-crew-n">${tab === 'rated' ? g.avg.toFixed(1) : g.count}</span></div>`).join('')}
            </div>`).join('')}</div>`
            : `<p class="stats-empty">${loaded ? 'Nothing yet' : 'Loading…'}</p>`}`;
    section.querySelectorAll('.stats-section-tabs button').forEach((b) => b.addEventListener('click', () => { statsTabs.crew = b.dataset.tab; paintStatsCrew(section, items); }));
    section.querySelectorAll('.stats-crew-row').forEach((el) => el.addEventListener('click', () => openPerson(Number(el.dataset.id))));
}

// ---- Filtered "what I've watched" page (genre / country / language, from the Stats page) ----
// ---- Notification bell: new/upcoming releases from what you follow + activity ----
const NOTIF_READ_KEY = 'iveAlready.notifRead';
const notifRead = (() => { try { return new Set(JSON.parse(localStorage.getItem(NOTIF_READ_KEY) || '[]')); } catch { return new Set(); } })();
const saveNotifRead = () => { try { localStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...notifRead].slice(-800))); } catch { /* ignore */ } };
let notifItems = null, notifLoadedAt = 0, notifFilter = 'unread', notifLoading = null;
const notifEls = {
    bell: document.getElementById('notifBellBtn'), badge: document.getElementById('notifBadge'), panel: document.getElementById('notifPanel'),
    body: document.getElementById('notifBody'), markAll: document.getElementById('notifMarkAll'), close: document.getElementById('notifClose'),
};
const notifDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function getNotifPrefs() {
    try { return { releases: true, upcoming: true, activity: true, ...JSON.parse(localStorage.getItem('ia_notif_prefs') || '{}') }; }
    catch { return { releases: true, upcoming: true, activity: true }; }
}
async function loadNotifications(force = false) {
    if (!force && notifItems && Date.now() - notifLoadedAt < 15 * 60 * 1000) return notifItems;
    if (notifLoading) return notifLoading;
    notifLoading = (async () => {
        const items = [];
        const [releases, ex] = await Promise.all([
            window.api.getReleaseNotifications().catch(() => []),
            window.api.getActivityExtras().catch(() => ({})),
        ]);
        (releases || []).forEach((r) => items.push({
            id: r.id, group: r.upcoming ? 'Coming soon' : 'New releases', poster: r.poster_url,
            title: `${r.title}${r.date ? ` (${r.date.slice(0, 4)})` : ''}`,
            sub: `${r.sources.join(', ')} · ${r.role}`, when: `${r.upcoming ? 'Out' : 'Released'} ${notifDate(r.date)}`,
            open: () => openDetails(r.tmdb_id, r.media_type),
        }));
        const cutoff = Date.now() - 21 * 864e5;
        const recent = (at) => at && new Date(at).getTime() >= cutoff;
        [...(ex?.friends || []), ...(ex?.family || [])].filter((f) => f.media && recent(f.at)).forEach((f) => items.push({
            id: `act:${f.user_name}:${f.media.tmdb_id}:${String(f.at).slice(0, 10)}`, group: 'Activity',
            poster: f.media.poster_path ? imgSrc(f.media.poster_path) : '',
            title: `${f.user_name} watched ${f.media.title}`, sub: f.rating ? `Rated ${'★'.repeat(Math.floor(f.rating / 2))}${f.rating % 2 ? '½' : ''}` : '',
            when: activityAgo(f.at), open: () => openDetails(f.media.tmdb_id, f.media.media_type || 'movie'),
        }));
        (ex?.newFollowers || []).filter((f) => recent(f.at)).forEach((f) => items.push({
            id: `fol:${f.id}`, group: 'Activity', initial: (f.name || '?').charAt(0).toUpperCase(),
            title: `${f.name} started following you`, sub: '', when: activityAgo(f.at), open: () => {},
        }));
        (ex?.listLikes || []).filter((l) => recent(l.at)).forEach((l) => items.push({
            id: `ll:${l.list_id}:${l.user_id}`, group: 'Activity', initial: (l.user_name || '?').charAt(0).toUpperCase(),
            title: `${l.user_name} liked your list ${l.list_name || ''}`, sub: '', when: activityAgo(l.at), open: () => {},
        }));
        const prefs = getNotifPrefs();
        for (let i = items.length - 1; i >= 0; i--) {
            const g = items[i].group;
            if ((g === 'New releases' && !prefs.releases) || (g === 'Coming soon' && !prefs.upcoming) || (g === 'Activity' && !prefs.activity)) items.splice(i, 1);
        }
        notifItems = items; notifLoadedAt = Date.now();
        return items;
    })().finally(() => { notifLoading = null; });
    return notifLoading;
}

function paintNotifBadge() {
    const n = (notifItems || []).filter((i) => !notifRead.has(i.id)).length;
    notifEls.badge.textContent = n > 9 ? '9+' : String(n);
    notifEls.badge.classList.toggle('hidden', n === 0);
}

function paintNotifPanel() {
    const all = notifItems || [];
    const list = notifFilter === 'unread' ? all.filter((i) => !notifRead.has(i.id)) : notifFilter === 'read' ? all.filter((i) => notifRead.has(i.id)) : all;
    if (!list.length) {
        notifEls.body.innerHTML = `<div class="notif-empty">
            <svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="#bbb" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
            <h3>${notifFilter === 'unread' && all.length ? "You're all caught up" : notifFilter === 'read' ? 'Nothing read yet' : 'No notifications yet'}</h3>
            <p>Follow actors, directors and studios to hear about their new releases here.</p></div>`;
        return;
    }
    const groups = ['Coming soon', 'New releases', 'Activity'];
    notifEls.body.innerHTML = groups.map((g) => {
        const rows = list.filter((i) => i.group === g);
        if (!rows.length) return '';
        return `<div class="notif-group">${g}</div>` + rows.map((i) => `
            <div class="notif-row${notifRead.has(i.id) ? '' : ' unread'}" data-id="${escapeHtml(i.id)}">
                ${i.poster ? `<img class="notif-poster" src="${i.poster}" alt="">` : `<span class="notif-initial">${escapeHtml(i.initial || '?')}</span>`}
                <div class="notif-text"><div class="notif-title">${escapeHtml(i.title)}</div>
                    ${i.sub ? `<div class="notif-sub">${escapeHtml(i.sub)}</div>` : ''}<div class="notif-when">${escapeHtml(i.when)}</div></div>
                <span class="notif-dot"></span>
            </div>`).join('');
    }).join('');
    notifEls.body.querySelectorAll('.notif-row').forEach((row) => row.addEventListener('click', () => {
        const item = (notifItems || []).find((i) => i.id === row.dataset.id);
        if (!item) return;
        notifRead.add(item.id); saveNotifRead(); paintNotifBadge();
        closeNotifPanel();
        item.open();
    }));
}

async function openNotifPanel() {
    notifEls.panel.classList.remove('hidden');
    if (!notifItems) notifEls.body.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
    await loadNotifications(false).catch(() => { notifItems = []; });
    paintNotifPanel(); paintNotifBadge();
}
function closeNotifPanel() { notifEls.panel.classList.add('hidden'); }

const notifFilterHost = document.getElementById('notifFilter');
notifFilterHost.innerHTML = `<div class="seg">${[['unread', 'Unread'], ['read', 'Read'], ['all', 'All']].map(([k, l]) => `<button type="button" data-f="${k}" class="${k === notifFilter ? 'active' : ''}">${l}</button>`).join('')}</div>`;
notifFilterHost.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    notifFilter = b.dataset.f;
    notifFilterHost.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    paintNotifPanel();
}));
notifEls.bell.addEventListener('click', (e) => { e.stopPropagation(); notifEls.panel.classList.contains('hidden') ? openNotifPanel() : closeNotifPanel(); });
notifEls.close.addEventListener('click', closeNotifPanel);
notifEls.markAll.addEventListener('click', () => { (notifItems || []).forEach((i) => notifRead.add(i.id)); saveNotifRead(); paintNotifBadge(); paintNotifPanel(); });
document.addEventListener('mousedown', (e) => { if (!notifEls.panel.classList.contains('hidden') && !e.target.closest('#notifPanel, #notifBellBtn')) closeNotifPanel(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNotifPanel(); });
// quiet background refresh so the badge is right without opening the panel
const refreshNotifBadge = () => loadNotifications(true).then(paintNotifBadge).catch(() => {});
setTimeout(refreshNotifBadge, 5000);
setInterval(refreshNotifBadge, 20 * 60 * 1000);

// One round button (same as the Network tab's) that flips between grid and list view.
const VIEW_ICON_GRID = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>';
const VIEW_ICON_LIST = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>';
function wireCollectionViewBtn(st, repaint) {
    const btn = document.getElementById('collectionViewBtn');
    const show = () => { btn.innerHTML = st.view === 'grid' ? VIEW_ICON_LIST : VIEW_ICON_GRID; btn.title = st.view === 'grid' ? 'Switch to list view' : 'Switch to grid view'; };
    show();
    btn.onclick = () => { st.view = st.view === 'grid' ? 'list' : 'grid'; show(); repaint(); };
}

async function openStatsFilter(f, { recordHistory = true } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'statsFilter', f };
    showPage('collection');
    const all = (await getAllEntriesCached().catch(() => [])).filter((e) => e.media_type === f.media && profileFinished(e));
    const genreOf = (e) => { try { return JSON.parse(e.genres || '[]'); } catch { return []; } };
    const yearOf = (e) => Number((e.release_date || '').slice(0, 4)) || 0;
    const match = (e) => {
        const fc = statsFacets[e.media_id] || {};
        if (f.kind === 'Genres') return genreOf(e).includes(f.value);
        if (f.kind === 'Countries') return (fc.countries || []).map((c) => STATS_COUNTRY_SHORT[c] || c).includes(f.value);
        if (f.kind === 'Languages') return (fc.languages || []).map(statsLanguageName).includes(f.value);
        if (f.kind === 'CountryNum') return (fc.country_codes || []).some((c) => ISO_NUM[c.toUpperCase()] === f.value);
        if (f.kind === 'Year') return yearOf(e) === f.value;
        if (f.kind === 'Decade') return yearOf(e) && Math.floor(yearOf(e) / 10) * 10 === f.value;
        return false;
    };
    const films = all.filter(match).map((e) => ({ entry: e, id: e.tmdb_id, title: e.title, release_date: e.release_date || '', year: yearOf(e), genres: genreOf(e), popularity: e.popularity || 0 }));
    document.getElementById('collectionPageTitle').textContent = f.label;
    const st = { decade: 'all', genre: 'all', sort: 'rating', asc: false, view: 'grid' };
    const decades = [...new Set(films.map((x) => x.year && Math.floor(x.year / 10) * 10).filter(Boolean))].sort();
    const genres = [...new Set(films.flatMap((x) => x.genres))].sort();
    const mk = (id, options, onChange) => { const host = document.getElementById(id); host.innerHTML = ''; createCustomSelect({ container: host, options, value: options[0].value, onChange }); };
    mk('collectionDecade', [{ value: 'all', label: 'Any Decade' }, ...decades.map((d) => ({ value: String(d), label: `${d}s` }))], (v) => { st.decade = v; paint(); });
    mk('collectionGenre', [{ value: 'all', label: 'Any Genre' }, ...genres.map((x) => ({ value: x, label: x }))], (v) => { st.genre = v; paint(); });
    const sortHost = document.getElementById('collectionSort');
    sortHost.innerHTML = '';
    createCustomSelect({
        container: sortHost,
        options: [{ value: 'rating', label: 'Sort by My Rating' }, { value: 'release', label: 'Release Date' }, { value: 'title', label: 'Alphabetical' }, { value: 'popularity', label: 'Popularity' }],
        value: 'rating', onChange: (v) => { st.sort = v; paint(); },
    });
    const dirBtn = document.getElementById('collectionSortDir');
    dirBtn.classList.remove('ascending');
    dirBtn.onclick = () => { st.asc = !st.asc; dirBtn.classList.toggle('ascending', st.asc); paint(); };
    wireCollectionViewBtn(st, () => paint());

    const noun = (n) => { const m = STATS_NOUN[f.media] || STATS_NOUN.movie; return m[n === 1 ? 0 : 1]; };
    const how = f.kind === 'Genres' ? `in the ${f.label} genre` : f.kind === 'Languages' ? `in ${f.label}`
        : f.kind === 'Year' ? `released in ${f.label}` : f.kind === 'Decade' ? `released in the ${f.label}` : `produced in ${f.label}`;
    function paint() {
        const info = document.getElementById('collectionPageInfo');
        info.innerHTML = `You've ${statsVerb()} <b>${films.length}</b> ${noun(films.length)} ${how}.${f.kind === 'CountryNum' || f.kind === 'Countries' ? ' <a class="studio-link" id="statsFilterMap">See world map</a>.' : ''}`;
        document.getElementById('statsFilterMap')?.addEventListener('click', () => goBack());
        const list = films.filter((x) => (st.decade === 'all' || (x.year && String(Math.floor(x.year / 10) * 10) === st.decade)) && (st.genre === 'all' || x.genres.includes(st.genre)));
        const dir = st.asc ? 1 : -1;
        list.sort((a, b) => {
            if (st.sort === 'title') return dir * a.title.localeCompare(b.title);
            if (st.sort === 'release') return dir * a.release_date.localeCompare(b.release_date);
            if (st.sort === 'popularity') return dir * (a.popularity - b.popularity);
            return dir * ((a.entry.rating ?? -1) - (b.entry.rating ?? -1)) || a.title.localeCompare(b.title);
        });
        const grid = document.getElementById('collectionPageGrid');
        grid.className = st.view === 'list' ? 'collection-page-list' : 'poster-grid collection-page-grid';
        if (!list.length) { grid.innerHTML = '<p class="stats-empty">Nothing matches these filters.</p>'; return; }
        if (st.view === 'list') {
            grid.innerHTML = list.map((x) => `<div class="collection-row watched" data-tmdb-id="${x.id}" data-media-type="${x.entry.media_type}">
                <img src="${x.entry.poster_url || (x.entry.poster_path ? imgSrc(x.entry.poster_path) : '')}" alt="" loading="lazy">
                <span class="collection-row-title">${escapeHtml(x.title)}</span><span class="collection-row-year">${x.year || ''}</span>
                <span class="collection-row-status">${x.entry.rating ? formatBadgeRating(x.entry) : ''}</span></div>`).join('');
            grid.querySelectorAll('[data-tmdb-id]').forEach((el) => el.addEventListener('click', () => openDetails(Number(el.dataset.tmdbId), el.dataset.mediaType)));
        } else {
            renderPosterGrid(grid, list.map((x) => x.entry), st.sort === 'rating' ? 'rating' : 'release_date');
        }
    }
    paint();
}

// ---- World map ----
const ISO_NUM = { AF: 4, AL: 8, DZ: 12, AS: 16, AD: 20, AO: 24, AG: 28, AZ: 31, AR: 32, AU: 36, AT: 40, BS: 44, BH: 48, BD: 50, AM: 51, BB: 52, BE: 56, BM: 60, BT: 64, BO: 68, BA: 70, BW: 72, BR: 76, BZ: 84, SB: 90, BN: 96, BG: 100, MM: 104, BI: 108, BY: 112, KH: 116, CM: 120, CA: 124, CV: 132, CF: 140, LK: 144, TD: 148, CL: 152, CN: 156, TW: 158, CO: 170, KM: 174, CG: 178, CD: 180, CR: 188, HR: 191, CU: 192, CY: 196, CZ: 203, BJ: 204, DK: 208, DM: 212, DO: 214, EC: 218, SV: 222, GQ: 226, ET: 231, ER: 232, EE: 233, FO: 234, FJ: 242, FI: 246, FR: 250, GF: 254, PF: 258, DJ: 262, GA: 266, GE: 268, GM: 270, PS: 275, DE: 276, GH: 288, GR: 300, GL: 304, GT: 320, GN: 324, GY: 328, HT: 332, HN: 340, HK: 344, HU: 348, IS: 352, IN: 356, ID: 360, IR: 364, IQ: 368, IE: 372, IL: 376, IT: 380, CI: 384, JM: 388, JP: 392, KZ: 398, JO: 400, KE: 404, KP: 408, KR: 410, KW: 414, KG: 417, LA: 418, LB: 422, LS: 426, LV: 428, LR: 430, LY: 434, LT: 440, LU: 442, MO: 446, MG: 450, MW: 454, MY: 458, ML: 466, MT: 470, MR: 478, MU: 480, MX: 484, MN: 496, MD: 498, ME: 499, MA: 504, MZ: 508, OM: 512, NA: 516, NP: 524, NL: 528, NC: 540, VU: 548, NZ: 554, NI: 558, NE: 562, NG: 566, NO: 578, PK: 586, PA: 591, PG: 598, PY: 600, PE: 604, PH: 608, PL: 616, PT: 620, GW: 624, TL: 626, PR: 630, QA: 634, RO: 642, RU: 643, RW: 646, SA: 682, SN: 686, RS: 688, SL: 694, SG: 702, SK: 703, VN: 704, SI: 705, SO: 706, ZA: 710, ZW: 716, ES: 724, SS: 728, SD: 729, EH: 732, SR: 740, SZ: 748, SE: 752, CH: 756, SY: 760, TJ: 762, TH: 764, TG: 768, TT: 780, AE: 784, TN: 788, TR: 792, TM: 795, UG: 800, UA: 804, MK: 807, EG: 818, GB: 826, TZ: 834, US: 840, BF: 854, UY: 858, UZ: 860, VE: 862, YE: 887, ZM: 894,
    SU: 643, YU: 688, CS: 688, XC: 203, DD: 276 };
let statsWorld = null; // { features: [{ num, name, d }], w, h }

function buildWorldPaths(topo) {
    const W = 1000, scale = W / (2 * Math.PI);
    const miller = (lat) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * (lat * Math.PI / 180)));
    const yTop = miller(84), yBot = miller(-58);
    const H = (yTop - yBot) * scale;
    const proj = ([lon, lat]) => [(lon + 180) / 360 * W, (yTop - miller(Math.max(-58, Math.min(84, lat)))) * scale];
    const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
    const arcs = topo.arcs.map((arc) => { let x = 0, y = 0; return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; }); });
    const ringPts = (idxs) => { const pts = []; idxs.forEach((i) => { const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i]; a.forEach((p, k) => { if (pts.length && k === 0) return; pts.push(p); }); }); return pts; };
    const ringPath = (idxs) => {
        let d = '', prev = null;
        ringPts(idxs).map(proj).forEach(([x, y]) => {
            d += (prev === null || Math.abs(x - prev) > W / 2 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
            prev = x;
        });
        return d + 'Z';
    };
    const features = topo.objects.countries.geometries.map((g) => {
        const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
        return { num: Number(g.id), name: (g.properties && g.properties.name) || '', d: polys.map((poly) => poly.map(ringPath).join('')).join('') };
    });
    return { features, w: W, h: Math.round(H) };
}

// Literature: an author's country (from Wikidata) stands in for the book's country.
const bookAuthorCountry = {};
async function ensureBookCountries(items) {
    const dirsOf = (e) => (statsFacets[e.media_id]?.dirs || []);
    const ids = [...new Set(items.flatMap((e) => dirsOf(e).map((d) => d[0])))].filter((id) => id && !(id in bookAuthorCountry));
    if (ids.length) {
        let got = {};
        try { got = await window.api.getAuthorCountries(ids); } catch { /* map stays partial */ }
        ids.forEach((id) => { bookAuthorCountry[id] = got[id] || ''; });
    }
    let regions = null;
    try { regions = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* names fall back to codes */ }
    items.forEach((e) => {
        const fc = statsFacets[e.media_id];
        if (!fc) return;
        const codes = [...new Set(dirsOf(e).map((d) => bookAuthorCountry[d[0]]).filter(Boolean))];
        fc.country_codes = codes;
        fc.countries = codes.map((c) => { try { return (regions && regions.of(c === 'SU' ? 'RU' : c)) || c; } catch { return c; } });
    });
}

async function paintStatsMap(section, items) {
    if (statsMedia === 'book') {
        section.innerHTML = '<div class="stats-section-head"><h3>WORLD MAP</h3><span class="stats-section-line"></span></div><div class="stats-map-wrap"><p class="stats-empty">Looking up authors\' countries…</p></div>';
        await ensureBookCountries(items);
        if (!section.isConnected) return;
        const fac = document.getElementById('statsFacets');
        if (fac) paintStatsFacets(fac, items);
    }
    const counts = {};
    items.forEach((e) => (statsFacets[e.media_id]?.country_codes || []).forEach((c) => {
        const num = ISO_NUM[c.toUpperCase()];
        if (num) counts[num] = (counts[num] || 0) + 1;
    }));
    const unitCap = statsNoun(2).charAt(0).toUpperCase() + statsNoun(2).slice(1);
    section.innerHTML = `<div class="stats-section-head"><h3>WORLD MAP</h3><span class="stats-section-line"></span></div><div class="stats-map-wrap"><p class="stats-empty">Loading map…</p></div>`;
    if (!statsWorld) {
        try { const topo = await window.api.getWorldMap(); if (topo) statsWorld = buildWorldPaths(topo); }
        catch (err) { console.error('world map failed:', err); }
    }
    if (!section.isConnected) return;
    const wrap = section.querySelector('.stats-map-wrap');
    if (!statsWorld) { wrap.innerHTML = '<p class="stats-empty">Couldn\'t load the map (needs an internet connection).</p>'; return; }
    const max = Math.max(1, ...Object.values(counts));
    const fill = (n) => !n ? '#d2d2d2' : statsLerpColor('e3b4b4', 'b74b4b', Math.min(1, Math.log(n + 1) / Math.log(max + 1)));
    const w = statsWorld.w, h = statsWorld.h;
    wrap.innerHTML = `
        <svg class="stats-map" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
            <g id="statsMapG">${statsWorld.features.map((f) => `<path class="stats-country" data-num="${f.num}" data-name="${escapeHtml(STATS_COUNTRY_SHORT[f.name] || f.name)}" d="${f.d}" fill="${fill(counts[f.num])}"></path>`).join('')}</g>
        </svg>
        <div class="stats-map-zoom"><button type="button" data-z="1">+</button><button type="button" data-z="-1">&minus;</button></div>
        <div class="stats-tip hidden" id="statsMapTip"></div>`;
    const svg = wrap.querySelector('svg'), tip = wrap.querySelector('#statsMapTip');
    let zoom = 1, cx = w / 2, cy = h / 2;
    const applyView = () => {
        const vw = w / zoom, vh = h / zoom;
        cx = Math.max(vw / 2, Math.min(w - vw / 2, cx)); cy = Math.max(vh / 2, Math.min(h - vh / 2, cy));
        svg.setAttribute('viewBox', `${cx - vw / 2} ${cy - vh / 2} ${vw} ${vh}`);
    };
    wrap.querySelectorAll('.stats-map-zoom button').forEach((b) => b.addEventListener('click', () => { zoom = Math.max(1, Math.min(8, zoom * (b.dataset.z === '1' ? 1.6 : 1 / 1.6))); applyView(); }));
    let drag = null, lastDragMoved = false;
    svg.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, cx, cy, moved: false }; });
    svg.addEventListener('click', (e) => {
        const t = e.target.closest('.stats-country');
        if (!t || (lastDragMoved)) return;
        if (!counts[t.dataset.num]) { showToast(`No ${statsNoun(2)} from ${t.dataset.name} yet`); return; }
        openStatsFilter({ kind: 'CountryNum', value: Number(t.dataset.num), label: t.dataset.name, media: statsMedia });
    });
    window.addEventListener('mouseup', () => { lastDragMoved = Boolean(drag && drag.moved); drag = null; });
    svg.addEventListener('mousemove', (e) => {
        if (drag) {
            const r = svg.getBoundingClientRect(), k = (w / zoom) / r.width;
            if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
            cx = drag.cx - (e.clientX - drag.x) * k; cy = drag.cy - (e.clientY - drag.y) * k; applyView();
        }
        const t = e.target.closest('.stats-country');
        if (!t) { tip.classList.add('hidden'); return; }
        const n = counts[t.dataset.num] || 0;
        tip.innerHTML = `<strong>${escapeHtml(t.dataset.name)}</strong><span>${unitCap} ${statsVerb()}: ${n.toLocaleString()}</span>`;
        const wr = wrap.getBoundingClientRect();
        tip.style.left = `${e.clientX - wr.left}px`; tip.style.top = `${e.clientY - wr.top - 8}px`;
        tip.classList.remove('hidden');
    });
    svg.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

// ---- Section: Collections (movies only) ----
// Most Popular = franchises you've watched 2+ films of. Complete / Almost
// Complete compare your watched films with each collection's full film list
// from TMDB. Always all-time, regardless of the year filter.
let statsCollectionsTab = 'popular';
let statsCollectionsShowAll = false;
let statsCollectionTotals = {};

function paintStatsCollections(section, items) {
    if (statsMedia === 'book') { paintBookCollections(section, items); return; }
    if (statsMedia === 'game') { paintGameCollections(section, items); return; }
    if (statsMedia !== 'movie') { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    const groups = {};
    items.forEach((e) => {
        const c = statsFacets[e.media_id]?.collection;
        if (c) (groups[c.id] ||= { id: c.id, name: c.name, films: [] }).films.push(e);
    });
    const loaded = items.some((e) => statsFacets[e.media_id]);
    const all = Object.values(groups);
    const seen = (e) => e.status === 'completed' || e.status === 'rewatched';
    const info = all.map((g) => {
        const t = statsCollectionTotals[g.id];
        const watchedFilms = g.films.filter(seen);
        const parts = t ? new Set(t.parts) : null;
        const watched = parts ? new Set(watchedFilms.filter((e) => parts.has(e.tmdb_id)).map((e) => e.tmdb_id)).size : watchedFilms.length;
        return { ...g, films: watchedFilms.length ? watchedFilms : g.films, total: t ? t.total : null, watched };
    });
    const popular = info.filter((g) => g.films.length >= 2)
        .sort((a, b) => b.films.length - a.films.length || a.name.localeCompare(b.name));
    const complete = info.filter((g) => g.total && g.total >= 2 && g.watched >= g.total)
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const almost = info.filter((g) => g.total && g.total >= 2 && g.watched >= 1 && g.watched < g.total)
        .sort((a, b) => (a.total - a.watched) - (b.total - b.watched) || b.watched - a.watched);
    const totalsReady = all.every((g) => statsCollectionTotals[g.id]);
    const lists = { popular, complete, almost };
    const cur = lists[statsCollectionsTab];
    const shown = statsCollectionsShowAll ? cur : cur.slice(0, 12);
    const sub = (g) => statsCollectionsTab === 'almost' ? `${g.watched} of ${g.total} watched`
        : statsCollectionsTab === 'complete' ? `${g.total} watched` : `${g.watched} watched`;
    const tab = (k, label, n) => `<button type="button" data-tab="${k}" class="${statsCollectionsTab === k ? 'active' : ''}">${label}${n != null ? ` (${n})` : ''}</button>`;
    const emptyMsg = !loaded || (!totalsReady && statsCollectionsTab !== 'popular') ? 'Loading…'
        : statsCollectionsTab === 'popular' ? 'Watch two films from the same franchise to see collections.'
        : statsCollectionsTab === 'complete' ? 'No complete collections yet.' : 'No almost-complete collections yet.';

    section.innerHTML = `
        <div class="stats-section-head">
            <h3>COLLECTIONS</h3><span class="stats-section-line"></span>
            <div class="stats-section-tabs">
                ${tab('popular', 'MOST POPULAR')}${tab('complete', 'COMPLETE', totalsReady ? complete.length : null)}${tab('almost', 'ALMOST COMPLETE', totalsReady ? almost.length : null)}
            </div>
        </div>
        ${shown.length ? `<div class="stats-collections">${shown.map((g) => {
            const films = [...g.films].sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '')).slice(0, 3);
            const slots = [0, 1, 2].map((i) => films[i]
                ? `<img src="${films[i].poster_url || (films[i].poster_path ? imgSrc(films[i].poster_path) : '')}" alt="${escapeHtml(films[i].title)}" title="${escapeHtml(films[i].title)}"
                       loading="lazy" data-tmdb-id="${films[i].tmdb_id}" data-media-type="${films[i].media_type}">`
                : '<div class="stats-collection-empty"></div>').join('');
            return `<div class="stats-collection" data-cid="${g.id}" tabindex="0">
                <div class="stats-collection-posters">${slots}</div>
                <div class="stats-collection-name">${escapeHtml(/collection$/i.test(g.name) ? g.name : `${g.name} Collection`)}
                    <span>${sub(g)}</span></div>
            </div>`; }).join('')}</div>
            ${cur.length > 12 ? `<button type="button" class="stats-show-all">${statsCollectionsShowAll ? 'Show less' : `Show all ${cur.length}`}</button>` : ''}`
            : `<p class="stats-empty">${emptyMsg}</p>`}
    `;
    section.querySelectorAll('.stats-section-tabs button').forEach((b) => b.addEventListener('click', () => {
        statsCollectionsTab = b.dataset.tab; statsCollectionsShowAll = false; paintStatsCollections(section, items);
    }));
    section.querySelector('.stats-show-all')?.addEventListener('click', () => {
        statsCollectionsShowAll = !statsCollectionsShowAll; paintStatsCollections(section, items);
    });
    section.querySelectorAll('.stats-collection').forEach((card) => card.addEventListener('click', () => {
        const g = info.find((x) => String(x.id) === card.dataset.cid);
        if (g) openCollectionPage(g, items.filter(seen));
    }));

    const need = all.map((g) => g.id).filter((id) => !statsCollectionTotals[id]);
    if (need.length && !section._fetching) {
        section._fetching = true;
        window.api.getStatsCollections(need).then((r) => {
            Object.assign(statsCollectionTotals, r || {});
            need.forEach((id) => { if (!statsCollectionTotals[id]) statsCollectionTotals[id] = { id, name: '', total: 0, parts: [] }; });
            section._fetching = false;
            if (section.isConnected) paintStatsCollections(section, items);
        }).catch(() => { section._fetching = false; });
    }
}


// Literature: collections are book series (a curated list in the main process); a series appears once
// you have a book from it in your library, matched by title.
let bookSeriesData = null;
let bookSeriesLoading = false;
function paintBookCollections(section, items) {
    section.classList.remove('hidden');
    const head = (tabs = '') => `<div class="stats-section-head"><h3>COLLECTIONS</h3><span class="stats-section-line"></span>${tabs}</div>`;
    if (!bookSeriesData) {
        section.innerHTML = head() + '<p class="stats-empty">Loading…</p>';
        if (!bookSeriesLoading) {
            bookSeriesLoading = true;
            window.api.getBookSeries().then((d) => { bookSeriesData = d || []; }).catch(() => { bookSeriesData = []; })
                .finally(() => { bookSeriesLoading = false; if (section.isConnected) paintBookCollections(section, items); });
        }
        return;
    }
    const seen = (e) => e.status === 'completed' || e.status === 'rewatched';
    const byTitle = {};
    items.forEach((e) => { (byTitle[statsNormTitle(e.title)] ||= []).push(e); });
    const info = bookSeriesData.map((s) => {
        const owned = s.books.map((b) => {
            for (const t of [b.title, ...(b.alt || [])]) { const hit = (byTitle[statsNormTitle(t)] || [])[0]; if (hit) return hit; }
            return null;
        });
        const mine = owned.filter(Boolean);
        const g = { id: `series:${s.id}`, sid: s.id, name: s.name, mediaType: 'book', series: s, owned, films: mine, total: s.books.length, watched: mine.filter(seen).length };
        g.open = async () => {
            let looked = [];
            try { looked = await window.api.lookupBookSeries(g.sid); } catch { /* covers are optional */ }
            const films = g.series.books.map((b, i) => {
                const e = g.owned[i];
                const l = looked[i] || {};
                return { id: e ? e.tmdb_id : (l.id || 0), title: b.title, release_date: b.year ? `${b.year}-01-01` : '', poster_path: (e && e.poster_path) || l.poster_path || null, genre_ids: [] };
            });
            statsCollectionTotals[g.id] = { id: g.id, name: g.name, total: films.length, parts: films.map((f) => f.id), films };
            openCollectionPage(g, g.films.filter(seen));
        };
        return g;
    }).filter((g) => g.films.length);
    paintCollectionCards(section, info, () => paintBookCollections(section, items), { done: 'read', empty: 'Add two books from the same series to see collections.' });
}

// Shared card grid for Literature and Videogames collections (tabs, show-all, click to open the series page).
function paintCollectionCards(section, info, repaint, words) {
    const head = (tabs = '') => `<div class="stats-section-head"><h3>COLLECTIONS</h3><span class="stats-section-line"></span>${tabs}</div>`;
    const popular = info.filter((g) => g.films.length >= 2).sort((a, b) => b.films.length - a.films.length || a.name.localeCompare(b.name));
    const complete = info.filter((g) => g.watched >= g.total).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const almost = info.filter((g) => g.watched >= 1 && g.watched < g.total).sort((a, b) => (a.total - a.watched) - (b.total - b.watched) || b.watched - a.watched);
    const lists = { popular, complete, almost };
    const cur = lists[statsCollectionsTab] || popular;
    const shown = statsCollectionsShowAll ? cur : cur.slice(0, 12);
    const sub = (g) => statsCollectionsTab === 'almost' ? `${g.watched} of ${g.total} ${words.done}` : statsCollectionsTab === 'complete' ? `${g.total} ${words.done}` : `${g.watched} ${words.done}`;
    const tab = (k, label, n) => `<button type="button" data-tab="${k}" class="${statsCollectionsTab === k ? 'active' : ''}">${label}${n != null ? ` (${n})` : ''}</button>`;
    const emptyMsg = statsCollectionsTab === 'popular' ? words.empty
        : statsCollectionsTab === 'complete' ? 'No complete series yet.' : 'No almost-complete series yet.';
    section.innerHTML = head(`<div class="stats-section-tabs">${tab('popular', 'MOST POPULAR')}${tab('complete', 'COMPLETE', complete.length)}${tab('almost', 'ALMOST COMPLETE', almost.length)}</div>`) + `
        ${shown.length ? `<div class="stats-collections">${shown.map((g) => {
            const books = [...g.films].sort((a, b) => (a.release_date || '').localeCompare(b.release_date || '')).slice(0, 3);
            const slots = [0, 1, 2].map((i) => books[i]
                ? `<img src="${books[i].poster_url || (books[i].poster_path ? imgSrc(books[i].poster_path) : '')}" alt="${escapeHtml(books[i].title)}" title="${escapeHtml(books[i].title)}" loading="lazy">`
                : '<div class="stats-collection-empty"></div>').join('');
            return `<div class="stats-collection" data-cid="${escapeHtml(g.id)}" tabindex="0">
                <div class="stats-collection-posters">${slots}</div>
                <div class="stats-collection-name">${escapeHtml(g.name)} <span>${sub(g)}</span></div>
            </div>`; }).join('')}</div>
            ${cur.length > 12 ? `<button type="button" class="stats-show-all">${statsCollectionsShowAll ? 'Show less' : `Show all ${cur.length}`}</button>` : ''}`
            : `<p class="stats-empty">${emptyMsg}</p>`}`;
    section.querySelectorAll('.stats-section-tabs button').forEach((b) => b.addEventListener('click', () => {
        statsCollectionsTab = b.dataset.tab; statsCollectionsShowAll = false; repaint();
    }));
    section.querySelector('.stats-show-all')?.addEventListener('click', () => { statsCollectionsShowAll = !statsCollectionsShowAll; repaint(); });
    section.querySelectorAll('.stats-collection').forEach((card) => card.addEventListener('click', async () => {
        const g = info.find((x) => x.id === card.dataset.cid);
        if (!g) return;
        card.style.opacity = '0.6';
        try { await g.open(); } finally { card.style.opacity = ''; }
    }));
}

// Videogames: series come from RAWG's "game-series" for each game you've finished; two games are in the
// same collection when either appears in the other's series list.
let gameSeriesCache = {};
let gameSeriesFetching = false;
function paintGameCollections(section, items) {
    section.classList.remove('hidden');
    const head = () => '<div class="stats-section-head"><h3>COLLECTIONS</h3><span class="stats-section-line"></span></div>';
    const ids = items.map((e) => e.tmdb_id);
    const missing = ids.filter((id) => !(id in gameSeriesCache));
    if (missing.length) {
        section.innerHTML = head() + '<p class="stats-empty">Loading…</p>';
        if (!gameSeriesFetching) {
            gameSeriesFetching = true;
            window.api.getGameSeries(missing).then((r) => { Object.assign(gameSeriesCache, r || {}); missing.forEach((id) => { if (!(id in gameSeriesCache)) gameSeriesCache[id] = []; }); })
                .catch(() => { missing.forEach((id) => { gameSeriesCache[id] = []; }); })
                .finally(() => { gameSeriesFetching = false; if (section.isConnected) paintGameCollections(section, items); });
        }
        return;
    }
    const seen = (e) => e.status === 'completed' || e.status === 'rewatched';
    // union-find over RAWG game ids
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
    const meta = new Map(); // id -> { name, released, image }
    items.forEach((e) => { meta.set(e.tmdb_id, { name: e.title, released: (e.release_date || '').slice(0, 10), image: e.poster_path }); if (!parent.has(e.tmdb_id)) parent.set(e.tmdb_id, e.tmdb_id); });
    items.forEach((e) => (gameSeriesCache[e.tmdb_id] || []).forEach((g) => { union(e.tmdb_id, g.id); if (!meta.has(g.id)) meta.set(g.id, { name: g.name, released: g.released || '', image: g.image }); }));
    const groups = {};
    for (const id of parent.keys()) (groups[find(id)] ||= []).push(id);
    const prefixName = (names) => {
        const split = names.map((n) => n.split(/\s+/));
        let k = 0;
        while (split.every((w) => w[k] && w[k].toLowerCase() === split[0][k].toLowerCase())) k++;
        const p = split[0].slice(0, k).join(' ').replace(/[:\-–\s]+$/, '');
        return p.length >= 3 ? p : names.slice().sort((a, b) => a.length - b.length)[0];
    };
    const byId = {};
    items.forEach((e) => { byId[e.tmdb_id] = e; });
    const info = Object.values(groups).filter((m) => m.length >= 2).map((members) => {
        const owned = members.map((id) => byId[id]).filter(Boolean);
        if (!owned.length) return null;
        const name = prefixName(members.map((id) => meta.get(id).name));
        const gid = `gseries:${Math.min(...members)}`;
        return {
            id: gid, name, mediaType: 'game', films: owned, total: members.length, watched: owned.filter(seen).length,
            open: async () => {
                const films = members.map((id) => ({ id, title: meta.get(id).name, release_date: meta.get(id).released || '', poster_path: (byId[id] && byId[id].poster_path) || meta.get(id).image || null, genre_ids: [] }));
                statsCollectionTotals[gid] = { id: gid, name, total: films.length, parts: members, films };
                openCollectionPage({ id: gid, name, mediaType: 'game', films: owned }, owned.filter(seen));
            },
        };
    }).filter(Boolean);
    paintCollectionCards(section, info, () => paintGameCollections(section, items), { done: 'played', empty: 'Finish two games from the same series to see collections.' });
}

const TMDB_MOVIE_GENRES = { 28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western' };
let collectionPageState = null;

function openCollectionPage(g, watchedEntries, { recordHistory = true } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'collection', g, watched: watchedEntries };
    showPage('collection');
    const t = statsCollectionTotals[g.id];
    const byTmdb = {};
    watchedEntries.forEach((e) => { byTmdb[e.tmdb_id] = e; });
    const films = (t && t.films && t.films.length ? t.films
        : g.films.map((e) => ({ id: e.tmdb_id, title: e.title, release_date: e.release_date || '', poster_path: e.poster_path, genre_ids: [] })))
        .map((f) => ({ ...f, entry: byTmdb[f.id], year: Number((f.release_date || '').slice(0, 4)) || 0 }));
    const mt = g.mediaType || 'movie';
    const isBook = mt === 'book' || mt === 'game';
    const W = mt === 'game' ? { n: 'games', did: 'played', Did: 'Played' } : { n: 'books', did: 'read', Did: 'Read' };
    const name = isBook || /collection$/i.test(g.name) ? g.name : `${g.name} Collection`;
    document.getElementById('collectionPageTitle').textContent = name;
    collectionPageState = { films, decade: 'all', genre: 'all', sort: 'release', asc: true, view: 'grid' };
    const st = collectionPageState;

    const decades = [...new Set(films.map((f) => f.year && Math.floor(f.year / 10) * 10).filter(Boolean))].sort();
    const genres = [...new Set(films.flatMap((f) => f.genre_ids || []))].map((id) => TMDB_MOVIE_GENRES[id]).filter(Boolean).sort();
    createCustomSelect({
        container: document.getElementById('collectionDecade'),
        options: [{ value: 'all', label: 'Any Decade' }, ...decades.map((d) => ({ value: String(d), label: `${d}s` }))],
        value: 'all', onChange: (v) => { st.decade = v; paint(); },
    });
    createCustomSelect({
        container: document.getElementById('collectionGenre'),
        options: [{ value: 'all', label: 'Any Genre' }, ...genres.map((x) => ({ value: x, label: x }))],
        value: 'all', onChange: (v) => { st.genre = v; paint(); },
    });
    createCustomSelect({
        container: document.getElementById('collectionSort'),
        options: [
            { value: 'release', label: 'Sort by Release Date' },
            { value: 'title', label: 'Alphabetical' },
            { value: 'rating', label: 'My Rating' },
            { value: 'popularity', label: 'Popularity' },
        ],
        value: 'release', onChange: (v) => { st.sort = v; paint(); },
    });
    const dirBtn = document.getElementById('collectionSortDir');
    dirBtn.classList.add('ascending');
    dirBtn.onclick = () => { st.asc = !st.asc; dirBtn.classList.toggle('ascending', st.asc); paint(); };
    wireCollectionViewBtn(st, () => paint());

    function paint() {
        const seenCount = films.filter((f) => f.entry).length;
        document.getElementById('collectionPageInfo').textContent =
            isBook ? `There are ${films.length} ${W.n} in this series. You've ${W.did} ${seenCount}.` : `There are ${films.length} films in this collection. You've watched ${seenCount}.`;
        let list = films.filter((f) =>
            (st.decade === 'all' || (f.year && String(Math.floor(f.year / 10) * 10) === st.decade))
            && (st.genre === 'all' || (f.genre_ids || []).some((id) => TMDB_MOVIE_GENRES[id] === st.genre)));
        const dir = st.asc ? 1 : -1;
        list.sort((a, b) => {
            if (st.sort === 'title') return dir * a.title.localeCompare(b.title);
            if (st.sort === 'rating') return dir * ((a.entry?.rating ?? -1) - (b.entry?.rating ?? -1));
            if (st.sort === 'popularity') return dir * ((a.popularity || 0) - (b.popularity || 0));
            return dir * (a.release_date || '').localeCompare(b.release_date || '');
        });
        const grid = document.getElementById('collectionPageGrid');
        grid.className = st.view === 'list' ? 'collection-page-list' : 'poster-grid collection-page-grid';
        const src = (f) => f.poster_path ? imgSrc(f.poster_path) : (f.entry && f.entry.poster_url) || '';
        if (!list.length) { grid.innerHTML = '<p class="stats-empty">Nothing matches these filters.</p>'; return; }
        if (st.view === 'list') {
            grid.innerHTML = list.map((f) => `<div class="collection-row${f.entry ? ' watched' : ''}" data-tmdb-id="${f.id}">
                    <img src="${src(f)}" alt="" loading="lazy">
                    <span class="collection-row-title">${escapeHtml(f.title)}</span>
                    <span class="collection-row-year">${f.year || ''}</span>
                    <span class="collection-row-status">${f.entry ? `&#10003; ${isBook ? W.Did : 'Watched'}${f.entry.rating ? ' · ' + formatBadgeRating(f.entry) : ''}` : ''}</span>
                </div>`).join('');
            grid.querySelectorAll('[data-tmdb-id]').forEach((el) => el.addEventListener('click', () => {
                if (Number(el.dataset.tmdbId)) openDetails(Number(el.dataset.tmdbId), mt);
            }));
        } else {
            const items = list.map((f) => ({
                ...(f.entry || {}), tmdb_id: f.id, media_type: mt, title: f.title,
                release_date: f.release_date, poster_url: src(f) || undefined,
            }));
            renderPosterGrid(grid, items, st.sort === 'rating' ? 'rating' : 'release_date');
            grid.querySelectorAll('.poster-card').forEach((card, i) => card.classList.toggle('collection-unwatched', !list[i].entry));
        }
    }
    paint();
}
document.getElementById('collectionBackBtn').addEventListener('click', goBack);

// The Official Lists account: its "profile" is its tab of public lists.
['listDetailOwnerAvatar', 'listDetailOwnerName'].forEach((id) => {
    document.getElementById(id).addEventListener('click', () => {
        if (!currentListDetail || !currentListDetail.is_official) return;
        openOfficialAccountPage();
    });
});

// Videogame achievements: the list comes from RAWG (Steam-style games only), you tick what you've unlocked.
async function setupAchievements(details) {
    const host = document.getElementById('achievementsHost');
    if (!host) return;
    host.innerHTML = '<h3>Achievements</h3><p class="ach-note">Loading…</p>';
    let list = [], unlocked = new Set();
    try {
        const [l, u] = await Promise.all([window.api.getGameAchievements(details.tmdb_id || details.id), window.api.getUnlockedAchievements(details.mediaId).catch(() => [])]);
        list = l || []; unlocked = new Set((u || []).map(Number));
    } catch (err) {
        if (host.isConnected) host.innerHTML = `<h3>Achievements</h3><p class="ach-note">Couldn't load achievements (${escapeHtml(err.message || 'error')}).</p>`;
        return;
    }
    if (!host.isConnected) return;
    if (!list.length) { host.innerHTML = '<h3>Achievements</h3><p class="ach-note">No achievements are listed for this game.</p>'; return; }
    let showAll = false;
    // The header and bar are built once so the fill animates between values; only the rows re-render.
    host.innerHTML = `
        <div class="progress-header"><h3>Achievements</h3><span id="achCount"></span></div>
        <div class="progress-bar"><div class="progress-fill" id="achFill" style="width:0%"></div></div>
        <div class="ach-list" id="achList"></div>
        <button type="button" class="stats-show-all ach-more" id="achMore"></button>`;
    const countEl = host.querySelector('#achCount'), fillEl = host.querySelector('#achFill');
    const listEl = host.querySelector('#achList'), moreEl = host.querySelector('#achMore');
    const paintBar = () => {
        const done = list.filter((a) => unlocked.has(a.id)).length;
        countEl.textContent = `${done} of ${list.length}`;
        fillEl.style.width = `${Math.round((done / list.length) * 100)}%`;
    };
    const paintRows = () => {
        const shown = showAll ? list : list.slice(0, 10);
        listEl.innerHTML = shown.map((a) => `
            <label class="ach-row${unlocked.has(a.id) ? ' done' : ''}" data-id="${a.id}">
                <input type="checkbox" ${unlocked.has(a.id) ? 'checked' : ''}>
                ${a.image ? `<img src="${escapeHtml(a.image)}" alt="" loading="lazy">` : '<span class="ach-img-empty"></span>'}
                <span class="ach-text"><span class="ach-name">${escapeHtml(a.name)}</span><span class="ach-desc">${escapeHtml(a.description || '')}</span></span>
                ${a.percent ? `<span class="ach-pct">${a.percent.toFixed(1)}%</span>` : ''}
            </label>`).join('');
        moreEl.style.display = list.length > 10 ? '' : 'none';
        moreEl.textContent = showAll ? 'Show less' : `Show all ${list.length}`;
    };
    listEl.addEventListener('change', async (ev) => {
        const cb = ev.target.closest('input');
        if (!cb) return;
        const row = cb.closest('.ach-row');
        const id = Number(row.dataset.id);
        const on = cb.checked;
        if (on) unlocked.add(id); else unlocked.delete(id);
        row.classList.toggle('done', on);
        paintBar();
        try { await window.api.setAchievementUnlocked(details.mediaId, id, on); }
        catch (err) {
            if (on) unlocked.delete(id); else unlocked.add(id);
            cb.checked = !on; row.classList.toggle('done', !on); paintBar();
            showToast(`Couldn't save: ${err.message}`, true);
        }
    });
    moreEl.addEventListener('click', () => { showAll = !showAll; paintRows(); });
    paintRows();
    requestAnimationFrame(() => requestAnimationFrame(paintBar)); // start at 0, then grow to the saved value
}


async function openOfficialAccountPage({ recordHistory = true } = {}) {
    if (recordHistory) pushNav(currentView);
    currentView = { type: 'officialAccount' };
    showPage('officialAccount');
    const host = document.getElementById('officialAccountBody');
    host.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p class="loading-text">Loading…</p></div>';
    let lists = [];
    try { lists = await window.api.listOfficialPublicLists(); } catch (err) { host.innerHTML = `<p class="empty-state">Couldn't load: ${escapeHtml(err.message)}</p>`; return; }
    // Which kind each official list is (Films / Series / Books / Videogames), from its title source.
    let officialSrc = officialListsCache || [];
    if (!officialSrc.length) { try { officialSrc = officialListsCache = (await window.api.listOfficialLists()) || []; } catch { officialSrc = []; } }
    const kindOfList = (l) => {
        const src = officialSrc.find((x) => x.list_id === l.id) || officialSrc.find((x) => x.name === l.name);
        return src?.media_type || 'movie';
    };
    lists.forEach((l) => { l._kind = kindOfList(l); });
    const KIND_TABS = [['movie', 'Films'], ['tv', 'Series'], ['book', 'Books'], ['game', 'Videogames']].filter(([k]) => lists.some((l) => l._kind === k));
    let listTab = 'all';
    const ownerId = lists[0]?.user_id || null;
    let fstate = { followers: 0, i_follow: false, is_me: false };
    if (ownerId) { try { fstate = await window.api.getFollowState(ownerId); } catch { /* keep defaults */ } }
    host.innerHTML = `
        <div class="profile-banner official-banner">
            <div class="profile-banner-bg" id="officialBannerBg"></div>
            <div class="profile-banner-header">
                <div class="profile-avatar-wrap"><div class="profile-avatar-large official-avatar"><img src="assets/official-icon.png" alt=""></div></div>
                <div class="profile-header-info">
                    <div class="profile-name-row">
                        <h1 class="profile-name-display">Official Lists <span class="list-hq-badge">HQ</span></h1>
                        ${ownerId && !fstate.is_me ? `<button type="button" id="officialFollowBtn" class="official-follow-btn${fstate.i_follow ? ' following' : ''}">${fstate.i_follow ? 'FOLLOWING' : 'FOLLOW'}</button>` : ''}
                        <div class="profile-menu-wrap">
                            <button type="button" id="officialMenuBtn" class="profile-menu-btn" title="More">&#8943;</button>
                            <div id="officialMenu" class="profile-menu hidden"><button type="button" data-act="copy">Copy profile link</button></div>
                        </div>
                    </div>
                    <p class="profile-bio-display">The official lists of I've Already. Track your progress on the classics, or clone any list to make it your own.</p>
                </div>
                <div class="profile-stats-row">
                    <div><div class="profile-stat-num">${lists.length}</div><div class="profile-stat-label">Lists</div></div>
                    <div><div class="profile-stat-num" id="officialFollowers">${fstate.followers}</div><div class="profile-stat-label">Followers</div></div>
                </div>
            </div>
        </div>
        <div class="profile-body"><div class="profile-tabs" id="officialListTabs">
            <button type="button" class="profile-tab active" data-tab="all">All <span class="entity-tab-n">${lists.length}</span></button>
            ${KIND_TABS.map(([k, label]) => `<button type="button" class="profile-tab" data-tab="${k}">${label} <span class="entity-tab-n">${lists.filter((l) => l._kind === k).length}</span></button>`).join('')}
        </div></div>
        <div class="lists-grid" id="officialListGrid">${lists.map((l) => `
            <div class="list-card" data-list-id="${l.id}" data-kind="${l._kind}">
                <div class="list-card-pile">${(l.preview_posters || []).length ? l.preview_posters.map((p, i) => `<img class="list-card-pile-poster" src="${imgSrc(p)}" alt="" style="z-index:${l.preview_posters.length - i};" loading="lazy">`).join('') : '<div class="list-card-pile-empty">No titles yet</div>'}</div>
                <div class="list-card-info">
                    <div class="list-card-name">${escapeHtml(l.name)}</div>
                    <div class="list-card-meta">${l.item_count} ${l.item_count === 1 ? 'title' : 'titles'}${l.like_count ? ` · <span class="list-card-likes">&#9829; ${l.like_count}</span>` : ''}</div>
                    ${l.description ? `<div class="list-card-desc">${escapeHtml(l.description)}</div>` : ''}
                </div>
            </div>`).join('')}</div>`;
    host.querySelectorAll('.list-card').forEach((c) => c.addEventListener('click', () => openListFromAnywhere(Number(c.dataset.listId))));
    host.querySelectorAll('#officialListTabs .profile-tab').forEach((b) => b.addEventListener('click', () => {
        listTab = b.dataset.tab;
        host.querySelectorAll('#officialListTabs .profile-tab').forEach((x) => x.classList.toggle('active', x === b));
        host.querySelectorAll('#officialListGrid .list-card').forEach((c) => { c.style.display = listTab === 'all' || c.dataset.kind === listTab ? '' : 'none'; });
    }));
    try {
        const pool = (await getAllEntriesCached()).filter((e) => e.backdrop_url);
        if (pool.length) {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            const bg = document.getElementById('officialBannerBg');
            bg.style.backgroundImage = `url('${pick.backdrop_url}')`;
            bg.style.backgroundSize = 'cover';
            bg.style.backgroundPosition = 'center 25%';
        }
    } catch { /* gradient fallback */ }
    const fbtn = document.getElementById('officialFollowBtn');
    if (fbtn) fbtn.addEventListener('click', async () => {
        fbtn.disabled = true;
        try {
            if (fstate.i_follow) { await window.api.unfollowUser(ownerId); fstate.i_follow = false; fstate.followers = Math.max(0, fstate.followers - 1); }
            else { await window.api.followUser(ownerId); fstate.i_follow = true; fstate.followers += 1; }
            fbtn.textContent = fstate.i_follow ? 'FOLLOWING' : 'FOLLOW';
            fbtn.classList.toggle('following', fstate.i_follow);
            document.getElementById('officialFollowers').textContent = fstate.followers;
        } catch (err) { showToast(`Couldn't update follow: ${err.message}`, true); }
        finally { fbtn.disabled = false; }
    });
    const omb = document.getElementById('officialMenuBtn'), om = document.getElementById('officialMenu');
    omb.addEventListener('click', (e) => { e.stopPropagation(); om.classList.toggle('hidden'); });
    om.addEventListener('click', async (e) => {
        if (e.target.dataset.act !== 'copy') return;
        try { await navigator.clipboard.writeText(`iveAlready://profile/${ownerId || 'official'}`); showToast('Profile link copied'); }
        catch { showToast("Couldn't copy the link", true); }
    });
}
document.getElementById('officialAccountBackBtn').addEventListener('click', goBack);

// Jump to a list from anywhere (e.g. Stats rings, the Official Lists page).
// Remembers where you came from so Back returns there instead of the Lists tab.
let listReturn = null; // { view, section }
function setListBackLabel(text) {
    const btn = document.getElementById('listDetailBackBtn');
    const node = [...btn.childNodes].reverse().find((n) => n.nodeType === 3 && n.textContent.trim());
    if (node) node.textContent = ` ${text}`;
}
function openListFromAnywhere(listId) {
    listReturn = { view: currentView, section: currentSection };
    navHistory = [];
    currentView = { type: 'catalog' };
    els.navBtns.forEach((b) => b.classList.toggle('active', b.dataset.section === 'lists'));
    showPage('catalog');
    switchSection('lists');
    openListDetail(listId);
    setListBackLabel('Back');
}

// ---- Section: List Progress (official lists, movies only for now) ----
let officialListsCache = null;

function statsNormTitle(t) {
    return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');
}

// A list item counts as watched if you have a completed/rewatched entry with
// the same title (or one of its alternate titles) released within a year of it.
function officialItemWatched(item, watchedIndex) {
    const names = [item.title, ...(item.alt_titles || [])].map(statsNormTitle);
    const tol = item.media_type === 'book' ? 3 : item.media_type === 'game' ? 2 : 1; // books: first-publication years vary between editions
    return names.some((n) => (watchedIndex.byTitle[n] || []).some((y) => !item.year || !y || Math.abs(y - item.year) <= tol));
}

const STATS_FEATURED_LISTS = {
    movie: ['oscar-best-picture', 'oscar-best-director', 'oscar-animated', 'oscar-international', 'oscar-most-awarded', 'cannes-palme-dor', 'pixar', 'studio-ghibli'],
    tv: ['emmy-drama', 'emmy-comedy', 'emmy-limited'],
    book: ['booker-prize', 'pulitzer-fiction', 'hugo-novel', 'penguin-classics'],
    game: ['game-awards-goty', 'zelda-mainline', 'super-mario-platformers', 'fromsoftware-souls', 'final-fantasy-mainline', 'grand-theft-auto'],
};
function paintStatsListProgress(section, ofType) {
    if (!['movie', 'tv', 'book', 'game'].includes(statsMedia)) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    const draw = (allLists) => {
        // Each stats page shows its own kind of list, counting only that kind of item
        // (the DC Universe list counts its films in Cinema and its series in Television).
        // Only the headline lists get a ring; every other official list is still on the Official Lists page.
        const featured = STATS_FEATURED_LISTS[statsMedia] || [];
        const lists = allLists
            .filter((l) => featured.includes(l.slug))
            .map((l) => ({ ...l, items: (l.items || []).filter((it) => (it.media_type || 'movie') === statsMedia) }))
            .filter((l) => l.items.length);
        const watched = ofType.filter((e) => e.status === 'completed' || e.status === 'rewatched');
        const idx = { byTitle: {} };
        watched.forEach((e) => {
            const y = Number((e.release_date || '').slice(0, 4)) || 0;
            (idx.byTitle[statsNormTitle(e.title)] ||= []).push(y);
        });
        const R = 54, C = 2 * Math.PI * R;
        section.innerHTML = `
            <div class="stats-section-head"><h3>LIST PROGRESS</h3><span class="stats-section-line"></span></div>
            ${lists.length ? `<div class="stats-rings">${lists.map((l) => {
                const done = l.items.filter((it) => officialItemWatched(it, idx)).length;
                const total = l.items.length || 1;
                const pct = Math.floor((done / total) * 100);
                const complete = done === total;
                const left = total - done;
                return `<button type="button" class="stats-ring${complete ? ' complete' : ''}" data-slug="${escapeHtml(l.slug)}">
                    <svg viewBox="0 0 120 120" class="stats-ring-svg">
                        <circle cx="60" cy="60" r="${R}" class="stats-ring-bg"/>
                        <circle cx="60" cy="60" r="${R}" class="stats-ring-fg" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - done / total)}" transform="rotate(-90 60 60)"/>
                    </svg>
                    <div class="stats-ring-text">
                        <div class="stats-ring-name">${escapeHtml(l.name)}</div>
                        <div class="stats-ring-count">${complete ? 'Complete!' : `${done} of ${total}`}</div>
                        <div class="stats-ring-sub">${pct}%${!complete && left <= 3 ? ` · only ${left} to go` : ''}</div>
                    </div>
                </button>`;
            }).join('')}</div>` : `<p class="stats-empty">${allLists.length ? 'No official lists for this page yet.' : 'No official lists yet (run official-lists-migration.sql).'}</p>`}
        `;
        section.querySelectorAll('.stats-ring').forEach((b) => b.addEventListener('click', () => {
            const l = lists.find((x) => x.slug === b.dataset.slug);
            if (!l) return;
            if (l.list_id) openListFromAnywhere(l.list_id);
            else openOfficialListOverlay(l, idx);
        }));
    };
    if (officialListsCache) { draw(officialListsCache); return; }
    section.innerHTML = '<div class="stats-section-head"><h3>LIST PROGRESS</h3><span class="stats-section-line"></span></div><p class="stats-empty">Loading…</p>';
    window.api.listOfficialLists().then((lists) => { officialListsCache = lists || []; if (section.isConnected) draw(officialListsCache); })
        .catch(() => { section.innerHTML = '<div class="stats-section-head"><h3>LIST PROGRESS</h3></div><p class="stats-empty">Lists aren\'t available yet (run official-lists-migration.sql).</p>'; });
}

function openOfficialListOverlay(list, idx) {
    document.getElementById('officialListOverlay')?.remove();
    const done = list.items.filter((it) => officialItemWatched(it, idx));
    const ov = document.createElement('div');
    ov.id = 'officialListOverlay';
    ov.className = 'official-overlay';
    ov.innerHTML = `
        <div class="official-box">
            <button type="button" class="roulette-close-btn" aria-label="Close">&#10005;</button>
            <h2>${escapeHtml(list.name)}</h2>
            <p class="official-sub">${done.length} of ${list.items.length} ${statsMedia === 'book' ? 'read' : statsMedia === 'game' ? 'played' : 'watched'}${list.description ? ` · ${escapeHtml(list.description)}` : ''}</p>
            <ol class="official-items">
                ${list.items.map((it) => {
                    const w = officialItemWatched(it, idx);
                    return `<li class="${w ? 'watched' : ''}"><span class="official-check">${w ? '&#10003;' : ''}</span>
                        <span class="official-title">${escapeHtml(it.title)}</span><span class="official-year">${it.year || ''}</span></li>`;
                }).join('')}
            </ol>
        </div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.roulette-close-btn')) ov.remove(); });
    document.body.appendChild(ov);
}


// ---- Official Lists account ----
// The two lists exist as real public lists after the SQL migration, but start
// empty: this one-time "match titles" step finds each film on TMDB and adds it.
// Only the account that owns them (you) ever sees it, and only while titles are missing.
function officialPending() {
    return (listsCache.official || [])
        .filter(() => officialAdmin)
        .map((l) => ({ list: l, source: officialSources.find((s) => s.list_id === l.id) || officialSources.find((s) => s.name === l.name) }))
        .filter((p) => p.source && p.list.item_count < p.source.items.length);
}

function renderOfficialSetupBanner() {
    let banner = document.getElementById('officialSetupBanner');
    const pending = listsActiveTab === 'official' ? officialPending() : [];
    const empty = (listsCache.official || []).filter((l) => l.item_count === 0);
    if (!pending.length && listsActiveTab === 'official' && empty.length) {
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'officialSetupBanner';
            banner.className = 'official-setup-banner';
            document.getElementById('listsGrid').before(banner);
        }
        const why = !officialAdmin ? 'this account isn\'t allowed to fill them (run the latest official-lists-migration.sql)'
            : officialSourcesError ? `couldn't read the title source: ${escapeHtml(officialSourcesError)}`
            : !officialSources.length ? 'the title source tables are empty (run the SQL again)'
            : `no matching source found (${officialSources.length} sources, ${officialSources.reduce((t, x) => t + x.items.length, 0)} titles)`;
        banner.innerHTML = `<span>These lists are empty because ${why}.</span>`;
        return;
    }
    if (!pending.length) { banner?.remove(); return; }
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'officialSetupBanner';
        banner.className = 'official-setup-banner';
        document.getElementById('listsGrid').before(banner);
    }
    const missing = pending.reduce((t, p) => t + (p.source.items.length - p.list.item_count), 0);
    banner.innerHTML = `<span>${missing} official titles still need to be matched to TMDB.</span>
        <button type="button" id="officialSetupBtn" class="save-btn" style="margin:0;">Match titles</button>`;
    document.getElementById('officialSetupBtn').addEventListener('click', runOfficialImport);
}

async function runOfficialImport() {
    const pending = officialPending();
    if (!pending.length) return;
    const ov = document.createElement('div');
    ov.className = 'official-overlay';
    ov.innerHTML = `<div class="official-box"><h2>Matching titles…</h2><p class="official-sub" id="officialImportStatus">Starting…</p>
        <div class="official-progress"><div id="officialImportBar"></div></div><p class="official-sub" id="officialImportFails"></p></div>`;
    document.body.appendChild(ov);
    const status = ov.querySelector('#officialImportStatus');
    const bar = ov.querySelector('#officialImportBar');
    const failsEl = ov.querySelector('#officialImportFails');

    const total = pending.reduce((t, p) => t + p.source.items.length, 0);
    let done = 0;
    const failed = [];
    let firstError = '';
    const norm = statsNormTitle;
    for (const { list, source } of pending) {
        // Skip what's already in the list so the step can be re-run safely.
        let have = new Set();
        try {
            const full = await window.api.getList(list.id);
            have = new Set(full.items.map((it) => `${norm(it.title)}|${(it.release_date || '').slice(0, 4)}`));
            var haveTitles = new Set(full.items.map((it) => norm(it.title)));
        } catch { var haveTitles = new Set(); }
        for (const item of source.items) {
            done++;
            bar.style.width = `${Math.round((done / total) * 100)}%`;
            status.textContent = `${source.name}: ${item.title} (${done} of ${total})`;
            if (haveTitles.has(norm(item.title)) || (item.alt_titles || []).some((a) => haveTitles.has(norm(a)))) continue;
            try {
                if (item.media_type === 'game') {
                    const hit = await window.api.findGame(item.title, item.year || 0);
                    if (!hit) { failed.push(`${item.title} (${item.year})`); continue; }
                    const gd = await window.api.getDetails(hit.tmdb_id, 'game');
                    try { await window.api.addOfficialListItem(list.id, gd.mediaId); }
                    catch (rpcErr) { await window.api.addListItem(list.id, gd.mediaId); }
                    continue;
                }
                if (item.media_type === 'book') {
                    const hit = await window.api.findBook(item.title, item.creator || '', item.year || 0, item.alt_titles || []);
                    if (!hit) { failed.push(item.creator ? `${item.title} (${item.creator})` : item.title); continue; }
                    const bookDetails = await window.api.getDetails(hit.tmdb_id, 'book');
                    try { await window.api.addOfficialListItem(list.id, bookDetails.mediaId); }
                    catch (rpcErr) { await window.api.addListItem(list.id, bookDetails.mediaId); }
                    continue;
                }
                const names = [item.title, ...(item.alt_titles || [])];
                let pick = null;
                for (const q of names) {
                    const results = (await window.api.searchTmdb(q, 'multi')).filter((r) => r.media_type === (item.media_type || 'movie'));
                    const wanted = names.map(norm);
                    pick = results.find((r) => wanted.includes(norm(r.title)) && Math.abs((Number((r.release_date || '').slice(0, 4)) || 0) - item.year) <= 1)
                        || results.find((r) => Math.abs((Number((r.release_date || '').slice(0, 4)) || 0) - item.year) === 0);
                    if (pick) break;
                }
                if (!pick) {
                    // Short or common titles ("Z") get buried in the general search — ask TMDB for that exact year instead.
                    const type = item.media_type || 'movie';
                    const wanted = names.map(norm);
                    for (const q of names) {
                        const byYear = await window.api.searchTmdb(q, type, item.year);
                        pick = byYear.find((r) => wanted.includes(norm(r.title)) && Math.abs((Number((r.release_date || '').slice(0, 4)) || 0) - item.year) <= 1) || null;
                        if (pick) break;
                    }
                }
                if (!pick) { failed.push(`${item.title} (${item.year})`); continue; }
                const details = await window.api.getDetails(pick.tmdb_id, item.media_type || 'movie');
                try { await window.api.addOfficialListItem(list.id, details.mediaId); }
                catch (rpcErr) { await window.api.addListItem(list.id, details.mediaId); } // owner fallback
            } catch (err) {
                console.error('official import failed for', item.title, err);
                if (!firstError) firstError = err.message || String(err);
                failed.push(`${item.title} (${item.year})`);
            }
        }
    }
    status.textContent = failed.length ? `Done — ${failed.length} title${failed.length === 1 ? '' : 's'} couldn't be matched.` : 'Done — everything matched!';
    failsEl.textContent = failed.length ? `Not matched: ${failed.join(', ')}${firstError ? ` — first error: ${firstError}` : ''}` : '';
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'save-btn'; close.textContent = 'Close';
    close.addEventListener('click', () => { ov.remove(); loadListsPage(); });
    ov.querySelector('.official-box').appendChild(close);
}


// ================= Import (Letterboxd / Steam) =================
(function setupImport() {
    const btn = document.getElementById('listImportBtn');
    if (!btn) return;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let imported = false;
    const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };

    function openModal(html) {
        document.querySelector('.import-overlay')?.remove();
        const ov = document.createElement('div');
        ov.className = 'official-overlay import-overlay';
        ov.innerHTML = `<div class="official-box import-box"><button type="button" class="import-x" aria-label="Close">&times;</button>${html}</div>`;
        document.body.appendChild(ov);
        const close = () => { ov.remove(); if (imported) window.location.reload(); };
        ov.querySelector('.import-x').addEventListener('click', close);
        ov.addEventListener('mousedown', (e) => { if (e.target === ov && !ov.dataset.busy) close(); });
        return { ov, close };
    }
    function progressView(ov, title) {
        ov.dataset.busy = '1';
        ov.querySelector('.import-box').innerHTML = `<h2>${esc(title)}</h2><p class="official-sub" id="impStatus">Starting…</p>
            <div class="official-progress"><div id="impBar"></div></div><p class="official-sub">Keep the app open until this finishes.</p>`;
        return window.api.onImportProgress((p) => {
            const st = ov.querySelector('#impStatus'), bar = ov.querySelector('#impBar');
            if (!st) return;
            st.textContent = `${p.label || ''} (${p.done} of ${p.total})`;
            bar.style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`;
        });
    }
    function resultView(m, title, lines, failed) {
        delete m.ov.dataset.busy;
        imported = true;
        m.ov.querySelector('.import-box').innerHTML = `<button type="button" class="import-x">&times;</button><h2>${esc(title)}</h2>
            ${lines.map((l) => `<p class="official-sub" style="margin-bottom:.5rem">${esc(l)}</p>`).join('')}
            ${failed.length ? `<p class="official-sub" style="margin-top:1rem">Couldn't match ${failed.length}:</p><ul class="official-items">${failed.slice(0, 60).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
            <button type="button" class="save-btn import-done" style="margin-top:1.6rem">Done</button>`;
        m.ov.querySelector('.import-x').addEventListener('click', m.close);
        m.ov.querySelector('.import-done').addEventListener('click', m.close);
    }

    function letterboxd(m, listsOnly = false) {
        m.ov.querySelector('.import-box').innerHTML = `<button type="button" class="import-x">&times;</button><h2>Letterboxd</h2>
            <p class="official-sub">${listsOnly ? 'Import your Letterboxd lists.' : 'Import your Letterboxd data.'} On letterboxd.com go to Settings → Data → <b>Export your data</b>, then choose the downloaded ZIP here. A single exported list (.csv) also works.</p>
            <input type="file" id="impFile" accept=".zip,.csv" hidden>
            <button type="button" class="save-btn" id="impPick">Choose file…</button><p class="official-sub" id="impMsg" style="margin-top:1rem"></p>`;
        m.ov.querySelector('.import-x').addEventListener('click', m.close);
        const file = m.ov.querySelector('#impFile'), msg = m.ov.querySelector('#impMsg');
        m.ov.querySelector('#impPick').addEventListener('click', () => file.click());
        file.addEventListener('change', async () => {
            const f = file.files[0]; if (!f) return;
            msg.textContent = 'Reading…';
            const r = await window.api.importLetterboxdParse(f.name, new Uint8Array(await f.arrayBuffer()));
            if (!r.ok) { msg.textContent = r.error || 'Could not read that file'; return; }
            const s = r.summary;
            const row = (id, label, n, on = true) => `<label class="import-opt${n ? '' : ' off'}"><input type="checkbox" id="${id}" ${on && n ? 'checked' : ''} ${n ? '' : 'disabled'}> ${label} <i>${n}</i></label>`;
            m.ov.querySelector('.import-box').innerHTML = `<button type="button" class="import-x">&times;</button><h2>Letterboxd</h2>
                <p class="official-sub">Choose what to import.</p>
                ${listsOnly ? '' : row('oDiary', `Watched films, ratings &amp; diary dates (${s.watched} films · ${s.rated} rated · ${s.diary} diary entries · ${s.liked} liked)`, s.watched + s.liked)}
                ${listsOnly ? '' : row('oWatch', 'Watchlist (added as Planned)', s.watchlist)}
                ${row('oLists', 'Lists (created as private lists)', s.lists.length)}
                ${s.lists.length ? `<p class="official-sub" style="margin:.4rem 0 0 2.6rem">${s.lists.slice(0, 8).map((l) => esc(l.name) + ' (' + l.count + ')').join(' · ')}${s.lists.length > 8 ? ' …' : ''}</p>` : ''}
                <p class="official-sub" style="margin-top:1rem">Existing ratings and entries are never overwritten. Ratings are converted to the 0–10 scale.</p>
                <button type="button" class="save-btn" id="impGo">Start import</button>`;
            m.ov.querySelector('.import-x').addEventListener('click', m.close);
            m.ov.querySelector('#impGo').addEventListener('click', async () => {
                const opts = { diary: !listsOnly && m.ov.querySelector('#oDiary').checked, watchlist: !listsOnly && m.ov.querySelector('#oWatch').checked, lists: m.ov.querySelector('#oLists').checked };
                const off = progressView(m.ov, 'Importing from Letterboxd…');
                const res = await window.api.importLetterboxdRun(opts);
                off();
                if (!res.ok) { resultView(m, 'Import stopped', [res.error || 'Something went wrong'], []); return; }
                const x = res.result;
                if (!listsOnly) { try { localStorage.setItem('ia_letterboxd', new Date().toISOString().slice(0, 10)); } catch {} renderConnected(); }
                resultView(m, 'Import finished', listsOnly ? [`${x.lists} lists`] : [`${x.entries} films added or updated`, `${x.logs} diary entries`, `${x.lists} lists`], x.failed);
            });
        });
    }

    async function steam(m) {
        const st = await window.api.importSteamStatus();
        m.ov.querySelector('.import-box').innerHTML = `<button type="button" class="import-x">&times;</button><h2>Steam</h2>
            ${st.configured ? '' : '<p class="official-sub" style="color:var(--accent)">Add <b>STEAM_API_KEY</b> to your .env (free key at steamcommunity.com/dev/apikey) and restart the app.</p>'}
            <p class="official-sub">Your Steam profile must be public (Privacy → Game details: Public). Paste your profile link, custom name or 17-digit Steam ID.</p>
            <input type="text" id="impSteam" class="profile-edit-field-input" placeholder="https://steamcommunity.com/id/yourname" value="${esc(lsGet('ia_steam'))}" ${st.configured ? '' : 'disabled'}>
            <p class="official-sub" id="impMsg" style="margin-top:1rem"></p>
            <button type="button" class="save-btn" id="impCheck" ${st.configured ? '' : 'disabled'}>Connect</button>`;
        m.ov.querySelector('.import-x').addEventListener('click', m.close);
        const input = m.ov.querySelector('#impSteam'), msg = m.ov.querySelector('#impMsg');
        m.ov.querySelector('#impCheck').addEventListener('click', async () => {
            msg.textContent = 'Looking up your library…';
            const r = await window.api.importSteamPreview(input.value);
            if (!r.ok) { msg.textContent = r.error; return; }
            try { localStorage.setItem('ia_steam', input.value.trim()); } catch {}
            renderConnected();
            m.ov.querySelector('.import-box').innerHTML = `<button type="button" class="import-x">&times;</button><h2>Steam</h2>
                <p class="official-sub">Found <b>${r.total}</b> games, <b>${r.played}</b> with playtime.</p>
                <label class="import-opt">Games you've played, add as
                    <select id="impStatus2"><option value="completed">Completed</option><option value="in_progress">Playing</option><option value="skip">Don't import</option></select></label>
                <label class="import-opt"><input type="checkbox" id="impUnplayed"> Add unplayed games to my backlog (Planned) <i>${r.total - r.played}</i></label>
                <p class="official-sub" style="margin-top:1rem">Games already in your tracker are left alone. Matching uses RAWG, so this can take a few minutes for big libraries.</p>
                <button type="button" class="save-btn" id="impGo">Start import</button>`;
            m.ov.querySelector('.import-x').addEventListener('click', m.close);
            m.ov.querySelector('#impGo').addEventListener('click', async () => {
                const args = { input: input.value, playedStatus: m.ov.querySelector('#impStatus2').value, unplayed: m.ov.querySelector('#impUnplayed').checked };
                const off = progressView(m.ov, 'Importing from Steam…');
                const res = await window.api.importSteamRun(args);
                off();
                if (!res.ok) { resultView(m, 'Import stopped', [res.error || 'Something went wrong'], []); return; }
                resultView(m, 'Import finished', [`${res.result.added} games added`, `${res.result.skipped} already tracked`], res.result.failed);
            });
        });
    }

    btn.addEventListener('click', () => letterboxd(openModal(''), true));

    // ---- Account settings → Connected accounts ----
    const svg = (p) => `<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    const CONN_ICONS = {
        lb: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/>'),
        steam: svg('<rect x="3" y="7" width="18" height="10" rx="5"/><path d="M8 10v4M6 12h4"/><circle cx="15" cy="11" r=".8"/><circle cx="17.2" cy="13" r=".8"/>'),
        psn: svg('<rect x="3" y="7" width="18" height="10" rx="5"/><path d="M8 10v4M6 12h4M15 10.5l2 3M17 10.5l-2 3"/>'),
        xbox: svg('<circle cx="12" cy="12" r="9"/><path d="M7.5 7.5c2 1.5 3 3 4.5 4.5 1.5-1.500 2.500-3 4.500-4.500M7.500 16.500c2-1.500 3-3 4.500-4.500 1.500 1.500 2.500 3 4.500 4.500"/>'),
        gog: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'),
    };
    // Official logos: drop letterboxd/steam/psn/xbox/gog .svg or .png files into renderer/assets/logos/ — the generic icon shows until they exist.
    const connLogo = (k0) => { const k = k0 === 'lb' ? 'letterboxd' : k0; return `<img class="conn-logo" src="assets/logos/${k}.svg" alt="" onerror="if(!this.dataset.p){this.dataset.p=1;this.src='assets/logos/${k}.png';}else{this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:decodeURIComponent('${encodeURIComponent(CONN_ICONS[k0])}')}).firstChild);}">`; };
    function renderConnected() {
        const box = document.getElementById('connectedAccounts');
        if (!box) return;
        const steamId = lsGet('ia_steam'), lb = lsGet('ia_letterboxd');
        const card = (k, name, sub, btns) => `<div class="conn-card"><div class="conn-icon">${connLogo(k)}</div><div class="conn-name">${name}</div><div class="conn-sub">${sub}</div><div class="conn-btns">${btns}</div></div>`;
        const dis = (txt) => `<button type="button" class="conn-btn" disabled>${txt}</button>`;
        box.innerHTML =
            card('lb', 'Letterboxd', lb ? `Last imported ${esc(lb)}` : 'Films, ratings, diary &amp; lists', `<button type="button" class="conn-btn primary" data-act="lb">${lb ? 'Import again' : 'Import'}</button>`) +
            card('steam', 'Steam', steamId ? esc(steamId.replace(/^https?:\/\/steamcommunity\.com\/(id|profiles)\//, '').replace(/\/$/, '')) : 'Owned games &amp; playtime',
                steamId ? `<button type="button" class="conn-btn primary" data-act="steam">Sync</button><button type="button" class="conn-btn remove" data-act="steamRemove">Remove</button>` : `<button type="button" class="conn-btn primary" data-act="steam">Connect</button>`) +
            card('psn', 'PlayStation Network', 'No public API', dis('Unavailable')) +
            card('xbox', 'Xbox', 'Coming later', dis('Unavailable')) +
            card('gog', 'GOG', 'No public API', dis('Unavailable'));
        box.querySelector('[data-act=lb]')?.addEventListener('click', () => letterboxd(openModal(''), false));
        box.querySelector('[data-act=steam]')?.addEventListener('click', () => steam(openModal('')));
        box.querySelector('[data-act=steamRemove]')?.addEventListener('click', () => { try { localStorage.removeItem('ia_steam'); } catch {} renderConnected(); });
    }
    renderConnected();
})();


// ================= Account settings wiring =================
(function wireAccountSettings() {
    const $ = (id) => document.getElementById(id);
    $('accountManageNotifBtn')?.addEventListener('click', () => setAccountSection('notifications'));

    // Notification preferences (stored on this device, applied to the bell)
    const prefs = getNotifPrefs();
    document.querySelectorAll('[data-notif-pref]').forEach((cb) => {
        cb.checked = !!prefs[cb.dataset.notifPref];
        cb.addEventListener('change', () => {
            const next = getNotifPrefs();
            next[cb.dataset.notifPref] = cb.checked;
            try { localStorage.setItem('ia_notif_prefs', JSON.stringify(next)); } catch {}
            loadNotifications(true).then(() => { paintNotifBadge(); paintNotifPanel(); }).catch(() => {});
        });
    });

    // Sign out everywhere else
    $('accountSignOutOthersBtn')?.addEventListener('click', async () => {
        if (!confirm('Sign out of every other device? You will stay signed in here.')) return;
        const r = await window.api.signOutOtherDevices();
        showToast(r.ok ? 'Signed out of all other devices' : (r.error || 'Could not sign out other devices'), !r.ok);
    });

    // Download my data
    $('accountDownloadBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.disabled = true; const label = btn.textContent; btn.textContent = 'Preparing…';
        try {
            invalidateEntriesCache();
            const entries = await getAllEntriesCached();
            const mine = await window.api.listMyLists();
            const lists = [];
            for (const l of mine) {
                try { const full = await window.api.getList(l.id); lists.push({ name: l.name, description: l.description, visibility: l.visibility, items: (full.items || []).map((it) => ({ title: it.title, type: it.media_type, year: (it.release_date || '').slice(0, 4) })) }); }
                catch { lists.push({ name: l.name, items: [] }); }
            }
            const out = {
                exported_at: new Date().toISOString(),
                entries: entries.map((e) => ({ title: e.title, type: e.media_type, year: (e.release_date || '').slice(0, 4), tmdb_id: e.tmdb_id, status: e.status, rating: e.rating, favorite: !!e.is_favorite, review: e.review, started: e.date_started, finished: e.date_finished, rewatched: e.date_rewatched })),
                lists,
            };
            const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = `ive-already-export-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            showToast('Your data was downloaded');
        } catch (err) { showToast(`Export failed: ${err.message || err}`, true); }
        btn.disabled = false; btn.textContent = label;
    });

    // Clear local cache
    $('accountClearCacheBtn')?.addEventListener('click', () => {
        if (!confirm('Clear cached data on this device? Your library is not affected.')) return;
        const keep = new Set(['ia_steam', 'ia_letterboxd', 'ia_notif_prefs']);
        try { Object.keys(localStorage).filter((k) => !keep.has(k)).forEach((k) => localStorage.removeItem(k)); } catch {}
        invalidateEntriesCache();
        showToast('Cache cleared');
        setTimeout(() => window.location.reload(), 400);
    });

    // Delete account
    $('accountDeleteBtn')?.addEventListener('click', async () => {
        const word = prompt('This permanently deletes your account and everything in it.\nType DELETE to confirm.');
        if (word !== 'DELETE') return;
        const r = await window.api.deleteMyAccount();
        if (!r.ok) { showToast(/delete_my_account/.test(r.error || '') ? 'Run delete-account-migration.sql in Supabase first' : (r.error || 'Could not delete account'), true); return; }
        window.location.reload();
    });
})();
