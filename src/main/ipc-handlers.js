const { ipcMain, Notification } = require('electron');
const sb = require('./supabase');
const tmdb = require('./tmdb');
const books = require('./books');
const rawg = require('./rawg');
const authorCountries = require('./author-countries');
const { SERIES: BOOK_SERIES } = require('./book-series');
const publishers = require('./publishers');
const tmdbCollections = require('./tmdb-collections');
const omdb = require('./omdb');
const studios = require('./studios');
const notifications = require('./notifications');

function registerHandlers() {
    // ---- auth ----
    ipcMain.handle('auth:signUp', async (_evt, { email, password }) => {
        return sb.signUp(email, password);
    });

    ipcMain.handle('auth:signIn', async (_evt, { email, password }) => {
        return sb.signIn(email, password);
    });

    ipcMain.handle('auth:signOut', async () => {
        await sb.signOut();
        return { success: true };
    });

    ipcMain.handle('auth:getSession', async () => {
        return sb.getSession();
    });

    ipcMain.handle('auth:updateEmail', async (_evt, { newEmail }) => {
        return sb.updateEmail(newEmail);
    });

    ipcMain.handle('auth:updatePassword', async (_evt, { newPassword }) => {
        return sb.updatePassword(newPassword);
    });

    // ---- family accounts (separate real accounts, local fast switcher) ----
    ipcMain.handle('family:list', async () => {
        return sb.listFamilyAccounts();
    });

    ipcMain.handle('family:switch', async (_evt, { id }) => {
        return sb.switchFamilyAccount(id);
    });

    ipcMain.handle('family:remove', async (_evt, { id }) => {
        sb.removeFamilyAccount(id);
        return { success: true };
    });

    ipcMain.handle('family:rename', async (_evt, { id, label }) => {
        sb.renameFamilyAccount(id, label);
        return { success: true };
    });

    // ---- person follows ----
    ipcMain.handle('person:follow', async (_evt, { tmdbPersonId, personName, profilePath }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.followPerson(session, { tmdbPersonId, personName, profilePath });
        return { success: true };
    });

    ipcMain.handle('person:unfollow', async (_evt, { tmdbPersonId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.unfollowPerson(session, tmdbPersonId);
        return { success: true };
    });

    ipcMain.handle('person:isFollowing', async (_evt, { tmdbPersonId }) => {
        const session = await sb.getSession();
        if (!session) return false;
        return sb.isFollowingPerson(session, tmdbPersonId);
    });

    ipcMain.handle('person:listFollowed', async () => {
        const session = await sb.getSession();
        if (!session) return [];
        return sb.listFollowedPeople(session);
    });

    // ---- profile ----
    ipcMain.handle('profile:get', async () => {
        const session = await sb.getSession();
        if (!session) return null;
        return sb.getProfile(session);
    });

    ipcMain.handle('profile:update', async (_evt, fields) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.upsertProfile(session, fields);
        return { success: true };
    });

    ipcMain.handle('profile:uploadAvatar', async (_evt, { fileName, base64Data, contentType }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        return sb.uploadAvatar(session, { fileName, base64Data, contentType });
    });

    // ---- family (real invite/accept relationship) ----
    ipcMain.handle('family:create', async (_evt, { name }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        return sb.createFamily(session, name);
    });

    ipcMain.handle('family:renameReal', async (_evt, { familyId, name }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.renameFamily(session, familyId, name);
        return { success: true };
    });

    ipcMain.handle('family:invite', async (_evt, { email }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.inviteToFamily(session, email);
        return { success: true };
    });

    ipcMain.handle('family:revokeInvite', async (_evt, { inviteId }) => {
        await sb.revokeFamilyInvite(inviteId);
        return { success: true };
    });

    ipcMain.handle('family:listMine', async () => {
        const session = await sb.getSession();
        if (!session) return { members: [], sentInvites: [] };
        return sb.listMyFamily(session);
    });

    ipcMain.handle('family:listInvitesForMe', async () => {
        const session = await sb.getSession();
        if (!session) return [];
        return sb.listPendingInvitesForMe(session);
    });

    ipcMain.handle('family:acceptInvite', async (_evt, { inviteId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.acceptFamilyInvite(session, inviteId);
        return { success: true };
    });

    ipcMain.handle('family:declineInvite', async (_evt, { inviteId }) => {
        await sb.declineFamilyInvite(inviteId);
        return { success: true };
    });

    ipcMain.handle('family:removeMember', async (_evt, { userId }) => {
        await sb.removeFamilyMember(userId);
        return { success: true };
    });

    // ---- custom lists ----
    ipcMain.handle('lists:create', async (_evt, { name, description, genres, isRanked, visibility }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        return sb.createList(session, { name, description, genres, isRanked, visibility });
    });

    ipcMain.handle('lists:rename', async (_evt, { listId, name, description, genres, isRanked, visibility }) => {
        await sb.renameList(listId, { name, description, genres, isRanked, visibility });
        return { success: true };
    });

    ipcMain.handle('lists:delete', async (_evt, { listId }) => {
        await sb.deleteList(listId);
        return { success: true };
    });

    const withSession = (fn, fallback) => async (_evt, args) => {
        const session = await sb.getSession();
        if (!session) return fallback;
        return fn(session, args || {});
    };
    ipcMain.handle('profile:activityExtras', withSession((s) => sb.getActivityExtras(s), { likedLists: [], newFollowers: [], following: [], listLikes: [], friends: [], family: [] }));
    // ---- account safety ----
    ipcMain.handle('auth:signOutOthers', async () => {
        const { error } = await sb.getClient().auth.signOut({ scope: 'others' });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
    });
    ipcMain.handle('auth:deleteAccount', async () => {
        const { error } = await sb.getClient().rpc('delete_my_account');
        if (error) return { ok: false, error: error.message };
        try { await sb.signOut(); } catch {}
        return { ok: true };
    });
    // ---- imports (Letterboxd export, Steam library) ----
    const importers = require('./importers');
    ipcMain.handle('import:letterboxdParse', withSession((s, { name, bytes }) => {
        try { return { ok: true, summary: importers.parseLetterboxd(s.user.id, name || '', bytes) }; }
        catch (err) { return { ok: false, error: err.message }; }
    }, { ok: false, error: 'Not signed in' }));
    ipcMain.handle('import:letterboxdRun', async (evt, { opts }) => {
        const s = await sb.getSession();
        if (!s) return { ok: false, error: 'Not signed in' };
        try { return { ok: true, result: await importers.runLetterboxd(s, opts || {}, (p) => evt.sender.send('import:progress', p)) }; }
        catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('import:steamStatus', async () => ({ configured: importers.steamConfigured() }));
    ipcMain.handle('import:steamPreview', async (_evt, { input }) => {
        try { const lib = await importers.steamLibrary(input); return { ok: true, total: lib.games.length, played: lib.games.filter((g) => g.hours > 0).length }; }
        catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('import:steamRun', async (evt, args) => {
        const s = await sb.getSession();
        if (!s) return { ok: false, error: 'Not signed in' };
        try { return { ok: true, result: await importers.runSteam(s, args || {}, (p) => evt.sender.send('import:progress', p)) }; }
        catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.handle('stats:authorCountries', async (_evt, { ids }) => { try { return await authorCountries.getAuthorCountries(ids || []); } catch (err) { console.error('author countries:', err.message); return {}; } });
    // Backdrop for a person / studio page: the most recent released credit that has a wide image.
    ipcMain.handle('entity:banner', async (_evt, { credits }) => {
        const today = new Date().toISOString().slice(0, 10);
        const recent = (credits || []).filter((c) => c.release_date && c.release_date <= today)
            .sort((a, b) => b.release_date.localeCompare(a.release_date));
        for (const c of recent.slice(0, 8)) {
            try {
                if (c.media_type === 'movie' || c.media_type === 'tv') {
                    const path = await tmdb.getBackdropPath(c.tmdb_id, c.media_type);
                    if (path) return tmdb.imageUrl(path, 'w1280');
                } else if (c.media_type === 'game' && c.poster_path) return c.poster_path;
            } catch { /* try the next one */ }
        }
        const book = recent.find((c) => c.media_type === 'book' && c.poster_path);
        return book ? book.poster_path : null;
    });
    ipcMain.handle('games:find', async (_evt, { title, year }) => rawg.findGame(title, year || 0));
    ipcMain.handle('games:series', async (_evt, { ids }) => rawg.getSeriesFor(ids || []));
    ipcMain.handle('games:achievements', async (_evt, { gameId }) => rawg.getAchievements(gameId));
    ipcMain.handle('games:progress', withSession(async (s, a) => {
        const items = a.items || [];
        const done = await sb.getUnlockedCounts(s, items.map((i) => i.mediaId));
        const out = {};
        await Promise.all(items.map(async (i) => { out[i.mediaId] = { done: done[i.mediaId] || 0, total: await rawg.achievementCount(i.gameId) }; }));
        return out;
    }, {}));
    ipcMain.handle('games:unlocked', withSession((s, a) => sb.getUnlockedAchievements(s, a.mediaId), []));
    ipcMain.handle('games:setUnlocked', withSession((s, a) => sb.setAchievementUnlocked(s, a.mediaId, a.achievementId, a.unlocked), false));
    ipcMain.handle('diary:episodes', withSession((s) => sb.listEpisodeLogs(s), []));
    ipcMain.handle('diary:list', withSession((s, a) => sb.listEntryLogs(s, a.entryId), []));
    ipcMain.handle('diary:add', withSession((s, a) => sb.addEntryLog(s, a), null));
    ipcMain.handle('diary:delete', withSession((s, a) => sb.deleteEntryLog(s, a.logId), null));
    ipcMain.handle('network:list', withSession((s, a) => sb.listNetwork(s, a.kind), []));
    ipcMain.handle('network:search', withSession((s, a) => sb.searchMembers(s, a.query), []));
    ipcMain.handle('network:state', withSession((s, a) => sb.getFollowState(s, a.userId), { followers: 0, i_follow: false, is_me: false }));
    ipcMain.handle('network:follow', withSession((s, a) => sb.followUser(s, a.userId), null));
    ipcMain.handle('network:unfollow', withSession((s, a) => sb.unfollowUser(s, a.userId), null));
    ipcMain.handle('lists:liked', withSession((s) => sb.listLikedLists(s), []));
    ipcMain.handle('profile:followCounts', async () => {
        const session = await sb.getSession();
        if (!session) return { following: 0, followers: 0 };
        return sb.getFollowCounts(session);
    });

    ipcMain.handle('lists:listMine', async () => {
        const session = await sb.getSession();
        if (!session) return [];
        return sb.listMyLists(session);
    });

    ipcMain.handle('lists:listShared', async () => {
        const session = await sb.getSession();
        if (!session) return [];
        return sb.listSharedWithMe(session);
    });

    ipcMain.handle('lists:listsContainingMedia', async (_evt, { mediaId }) => {
        const session = await sb.getSession();
        if (!session) return [];
        return sb.listsContainingMedia(session, mediaId);
    });

    ipcMain.handle('lists:get', async (_evt, { listId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        const list = await sb.getList(session, listId);
        return {
            ...list,
            items: list.items.map((it) => ({
                ...it,
                poster_url: tmdb.imageUrl(it.poster_path, 'w500'),
                backdrop_url: tmdb.imageUrl(it.backdrop_path, 'w1280'),
            })),
        };
    });

    ipcMain.handle('lists:addItem', async (_evt, { listId, mediaId }) => {
        await sb.addListItem(listId, mediaId);
        return { success: true };
    });

    ipcMain.handle('lists:removeItem', async (_evt, { listId, mediaId }) => {
        await sb.removeListItem(listId, mediaId);
        return { success: true };
    });

    ipcMain.handle('lists:setItemNote', async (_evt, { listId, mediaId, note }) => {
        await sb.setListItemNote(listId, mediaId, note);
        return { success: true };
    });

    ipcMain.handle('lists:reorder', async (_evt, { listId, mediaIds }) => {
        await sb.reorderListItems(listId, mediaIds);
        return { success: true };
    });

    ipcMain.handle('lists:share', async (_evt, { listId, targetUserId }) => {
        await sb.shareList(listId, targetUserId);
        return { success: true };
    });

    ipcMain.handle('lists:unshare', async (_evt, { listId, targetUserId }) => {
        await sb.unshareList(listId, targetUserId);
        return { success: true };
    });

    ipcMain.handle('lists:listShares', async (_evt, { listId }) => {
        return sb.listListShares(listId);
    });

    ipcMain.handle('lists:listOfficial', async () => {
        const session = await sb.getSession();
        if (!session) return [];
        return sb.listOfficialPublicLists(session);
    });

    ipcMain.handle('officialLists:list', async () => {
        const session = await sb.getSession();
        if (!session) return [];
        return sb.listOfficialLists();
    });

    ipcMain.handle('favorites:order', async () => {
        const session = await sb.getSession();
        if (!session) return { listId: null, items: [] };
        return sb.getFavoritesOrder(session);
    });
    ipcMain.handle('lists:setItemProfileVisible', async (_evt, { listId, mediaId, visible }) => sb.setListItemProfileVisible(listId, mediaId, visible));

    ipcMain.handle('officialLists:isAdmin', async () => {
        const session = await sb.getSession();
        if (!session) return false;
        return sb.isOfficialAdmin();
    });
    ipcMain.handle('officialLists:addItem', async (_evt, { listId, mediaId }) => sb.addOfficialListItem(listId, mediaId));

    ipcMain.handle('books:series', async () => BOOK_SERIES.map((s) => ({ id: s.id, name: s.name, author: s.author, books: s.books })));
    ipcMain.handle('books:lookupSeries', async (_evt, { id }) => {
        const s = BOOK_SERIES.find((x) => x.id === id);
        return s ? books.lookupSeries(s) : [];
    });
    ipcMain.handle('books:find', async (_evt, { title, creator, year, alts }) => {
        const r = await books.findBook(title, creator || '', year || 0, alts || []);
        return r ? { tmdb_id: r.tmdb_id, title: r.title, release_date: r.release_date, poster_path: r.poster_path } : null;
    });
    ipcMain.handle('stats:collections', async (_evt, { ids }) => tmdbCollections.getCollections(ids || []));

    ipcMain.handle('stats:tvWatchLog', async () => {
        const session = await sb.getSession();
        if (!session) return [];
        return sb.getTvWatchLog(session);
    });

    ipcMain.handle('stats:logCounts', async () => {
        const session = await sb.getSession();
        return session ? sb.getEntryLogCounts(session) : {};
    });
    let worldTopo = null;
    ipcMain.handle('stats:worldMap', async () => {
        if (worldTopo) return worldTopo;
        for (const url of ['https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json', 'https://unpkg.com/world-atlas@2/countries-110m.json']) {
            try {
                const res = await fetch(url);
                if (res.ok) { worldTopo = await res.json(); return worldTopo; }
            } catch (err) { console.error('world map fetch failed:', err.message); }
        }
        return null;
    });
    ipcMain.handle('stats:facets', async (_evt, { mediaIds }) => {
        const session = await sb.getSession();
        if (!session) return {};
        return sb.getMediaFacets(mediaIds || []);
    });

    ipcMain.handle('lists:clone', async (_evt, { listId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        return sb.cloneList(session, listId);
    });

    ipcMain.handle('lists:setVisibility', async (_evt, { listId, visibility }) => {
        await sb.setListVisibility(listId, visibility);
        return { success: true };
    });

    ipcMain.handle('listComments:list', async (_evt, { listId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        return sb.listComments(session, listId);
    });

    ipcMain.handle('listComments:isMuted', async (_evt, { listId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        return sb.isListThreadMuted(session, listId);
    });

    ipcMain.handle('listComments:toggleMute', async (_evt, { listId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        return sb.toggleListThreadMute(session, listId);
    });

    ipcMain.handle('listComments:add', async (_evt, { listId, body, parentId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.addListComment(session, listId, body, parentId);
        return { success: true };
    });

    ipcMain.handle('listComments:toggleLike', async (_evt, { commentId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.toggleCommentLike(session, commentId);
        return { success: true };
    });

    ipcMain.handle('listComments:delete', async (_evt, { commentId }) => {
        await sb.deleteListComment(commentId);
        return { success: true };
    });

    ipcMain.handle('lists:toggleLike', async (_evt, { listId }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        return sb.toggleListLike(session, listId);
    });

    ipcMain.handle('lists:reorderMine', async (_evt, { listIds }) => {
        const session = await sb.getSession();
        if (!session) throw new Error('Not signed in');
        await sb.reorderMyLists(session, listIds);
        return { success: true };
    });

    // ---- search ----
    ipcMain.handle('tmdb:search', async (_evt, { query, mediaType, year }) => {
        const mt = mediaType || 'multi';
        if (mt === 'book') {
            return (await books.searchBooks(query, 10)).results;
        }
        if (mt === 'game') return (await rawg.searchGames(query, 10)).results;
        if (mt !== 'multi') return tmdb.search(query, mt, year || null);
        // Books + authors ride along with the film/TV results; a books outage never breaks search.
        const [main, bk, au, gm] = await Promise.all([
            tmdb.search(query, mt),
            books.searchBooks(query, 4).then((r) => r.results).catch(() => []),
            books.searchAuthors(query, 1).catch(() => []),
            rawg.searchGames(query, 4).then((r) => r.results).catch(() => []),
        ]);
        return [...main, ...bk, ...au, ...gm];
    });

    // Full search-results page — same as tmdb:search but includes
    // director/creator per title, since that's too slow for the live
    // dropdown but fine for a dedicated results page.
    ipcMain.handle('tmdb:searchFull', async (_evt, { query, mediaType, page }) => {
        const mt = mediaType || 'multi';
        let results, pagination;
        if (mt === 'book') {
            const r = await books.searchBooks(query, 20, page || 1);
            results = r.results;
            pagination = { page: page || 1, totalPages: Math.min(Math.ceil(r.total / 20) || 1, 50), totalResults: r.total };
        } else if (mt === 'game') {
            const r = await rawg.searchGames(query, 20, page || 1);
            results = r.results;
            pagination = { page: page || 1, totalPages: Math.min(Math.ceil(r.total / 20) || 1, 50), totalResults: r.total };
        } else {
            const full = await tmdb.searchFull(query, mt, page || 1);
            ({ results, ...pagination } = full);
            if (mt === 'multi' && (page || 1) === 1) {
                const [bk, au, gm] = await Promise.all([
                    books.searchBooks(query, 8).then((r) => r.results).catch(() => []),
                    books.searchAuthors(query, 2).catch(() => []),
                    rawg.searchGames(query, 8).then((r) => r.results).catch(() => []),
                ]);
                results = [...results, ...bk, ...au, ...gm];
            }
        }
        const session = await sb.getSession();
        let statusMap = {};
        if (session) {
            try {
                statusMap = await sb.getStatusesForItems(session, results);
            } catch (err) {
                console.error('Failed to look up search result statuses:', err);
            }
        }
        return {
            ...pagination,
            results: results.map((r) => ({
                ...r,
                poster_url: tmdb.imageUrl(r.poster_path, 'w500'),
                status: statusMap[`${r.media_type}:${r.tmdb_id}`] || null,
            })),
        };
    });

    // ---- fetch + cache full details, return with this account's entry state if any ----
    ipcMain.handle('media:getDetails', async (_evt, { tmdbId, mediaType }) => {
        let details =
            mediaType === 'book'
                ? await books.getBookDetails(tmdbId)
                : mediaType === 'game'
                ? await rawg.getGameDetails(tmdbId)
                : mediaType === 'movie'
                    ? await tmdb.getMovieDetails(tmdbId)
                    : await tmdb.getTvDetails(tmdbId);

        const mediaId = await sb.upsertMedia(details);
        if (details.seasons) {
            try {
                await sb.upsertSeasonMeta(mediaId, details.seasons);
            } catch (err) {
                console.error('Failed to cache season art:', err);
            }
        }
        // Optional — silently skipped if OMDB_API_KEY isn't set (see
        // omdb.js). Checked at most once a week per title (see
        // updateMediaRatings) so an unreleased/unreviewed title isn't
        // re-queried on every single page view, but still picks up a
        // Tomatometer score once one actually exists.
        let ratings = null;
        try {
            const cached = await sb.getMediaRatingsCache(mediaId);
            const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
            const isFresh = cached?.ratings_checked_at && (Date.now() - new Date(cached.ratings_checked_at).getTime()) < oneWeekMs;
            if (isFresh) {
                ratings = { imdb_rating: cached.imdb_rating, imdb_votes: cached.imdb_votes, rt_tomatometer: cached.rt_tomatometer, awards: cached.awards_text };
            } else if (details.imdb_id) {
                ratings = (await omdb.getRatings(details.imdb_id)) || { imdb_rating: null, imdb_votes: null, rt_tomatometer: null, awards: null };
                await sb.updateMediaRatings(mediaId, { imdb_id: details.imdb_id, ...ratings });
            }
        } catch (err) {
            console.error('Failed to fetch/cache OMDb ratings:', err);
        }
        if (ratings) details = { ...details, ...ratings };

        const session = await sb.getSession();
        const entry = session ? await sb.getEntryForMedia(session, mediaId) : null;

        const resolveProviders = (list) =>
            (list || []).map((p) => ({ ...p, logo_url: tmdb.imageUrl(p.logo_path, 'w45') }));

        // Status flag on related/similar posters — only meaningful for a
        // logged-in user, and only for titles they've actually added.
        // Non-fatal: the rest of the page still works if this fails.
        let statusMap = {};
        if (session) {
            try {
                statusMap = await sb.getStatusesForItems(session, [...(details.related || []), ...(details.similar || [])]);
            } catch (err) {
                console.error('Failed to look up related/similar statuses:', err);
            }
        }
        const resolveRelatedList = (list) =>
            (list || []).map((item) => ({
                ...item,
                poster_url: tmdb.imageUrl(item.poster_path, 'w500'),
                status: statusMap[`${item.media_type}:${item.tmdb_id}`] || null,
            }));

        return {
            mediaId,
            ...details,
            poster_url: tmdb.imageUrl(details.poster_path, 'w500'),
            backdrop_url: tmdb.imageUrl(details.backdrop_path, 'w1280'),
            watch_providers: {
                ...details.watch_providers,
                flatrate: resolveProviders(details.watch_providers?.flatrate),
                rent: resolveProviders(details.watch_providers?.rent),
                buy: resolveProviders(details.watch_providers?.buy),
            },
            seasons: details.seasons
                ? details.seasons.map((s) => ({ ...s, poster_url: tmdb.imageUrl(s.poster_path, 'w500') }))
                : null,
            related: resolveRelatedList(details.related),
            similar: resolveRelatedList(details.similar),
            entry: entry || null,
        };
    });

    // ---- add/update a catalog entry (status, rating, review, dates) ----
    ipcMain.handle('entries:upsert', async (_evt, { mediaId, fields }) => {
        const session = await sb.getSession();
        return sb.upsertEntry(session, mediaId, fields);
    });

    ipcMain.handle('entries:delete', async (_evt, { entryId }) => {
        const session = await sb.getSession();
        await sb.deleteEntry(session, entryId);
        return { success: true };
    });

    ipcMain.handle('entries:list', async (_evt, { status, mediaType } = {}) => {
        const session = await sb.getSession();
        if (!session) return [];
        const rows = await sb.listEntries(session, { status, mediaType });
        return rows.map((r) => ({
            ...r,
            poster_url: tmdb.imageUrl(r.poster_path, 'w500'),
            backdrop_url: tmdb.imageUrl(r.backdrop_path, 'w1280'),
        }));
    });

    // Continue Watching progress bars — how many episodes of each
    // in-progress show the user has actually watched.
    ipcMain.handle('entries:getEpisodeProgress', async (_evt, { entryIds }) => {
        const session = await sb.getSession();
        if (!session) return {};
        return sb.getWatchedEpisodeCounts(session, entryIds);
    });

    // Bulk "which season did I stop at" for the Continue Watching row.
    ipcMain.handle('entries:getLastWatchedSeasons', async (_evt, { entryIds }) => {
        const session = await sb.getSession();
        if (!session) return {};
        return sb.getLastWatchedSeasons(session, entryIds);
    });

    // Season-specific poster art for the Continue Watching row — takes
    // [{ mediaId, seasonNumber }, ...], returns { "mediaId:seasonNumber": posterUrl }.
    ipcMain.handle('media:getSeasonPosters', async (_evt, { pairs }) => {
        const raw = await sb.getSeasonPosters(pairs);
        const result = {};
        for (const [key, posterPath] of Object.entries(raw)) result[key] = tmdb.imageUrl(posterPath, 'w342');
        return result;
    });

    // ---- person (cast/crew click-through) ----
    ipcMain.handle('tmdb:getPerson', async (_evt, { personId }) => {
        const person = personId < 0 ? await books.getAuthorDetails(personId) : await tmdb.getPersonDetails(personId);
        const session = await sb.getSession();
        let statusMap = {};
        if (session) {
            try {
                statusMap = await sb.getStatusesForItems(session, person.credits);
            } catch (err) {
                console.error('Failed to look up filmography statuses:', err);
            }
        }
        return {
            ...person,
            profile_url: tmdb.imageUrl(person.profile_path, 'h632'),
            credits: person.credits.map((c) => ({
                ...c,
                poster_url: tmdb.imageUrl(c.poster_path, 'w500'),
                status: statusMap[`${c.media_type}:${c.tmdb_id}`] || null,
            })),
        };
    });

    // ---- studios ----
    ipcMain.handle('notifications:releases', async () => {
        try {
            const session = await sb.getSession();
            if (!session) return [];
            const [people, studs] = await Promise.all([sb.listFollowedPeople(session).catch(() => []), sb.listFollowedStudios(session).catch(() => [])]);
            // Library-based alerts: new seasons of shows you've watched, sequels to films you've watched.
            let library = { tvIds: [], collections: [], ownedMovies: [] };
            try {
                const entries = await sb.listEntries(session, {});
                const done = (e) => ['completed', 'rewatched', 'in_progress'].includes(e.status);
                library.tvIds = [...new Set(entries.filter((e) => e.media_type === 'tv' && done(e)).map((e) => e.tmdb_id))].slice(0, 150);
                library.ownedMovies = entries.filter((e) => e.media_type === 'movie').map((e) => e.tmdb_id);
                const watchedMovies = entries.filter((e) => e.media_type === 'movie' && ['completed', 'rewatched'].includes(e.status) && e.media_id);
                const facets = await sb.getMediaFacets(watchedMovies.map((e) => e.media_id).slice(0, 200));
                library.collections = [...new Set(Object.values(facets).map((f) => f.collection?.id).filter(Boolean))].sort((x, y) => x - y);
            } catch (err) { console.error('library notifications:', err.message); }
            const items = await notifications.getReleaseNotifications(people || [], studs || [], library);
            return items.map((n) => ({ ...n, poster_url: tmdb.imageUrl(n.poster_path, 'w500') }));
        } catch (err) { console.error('notifications:', err.message); return []; }
    });
    ipcMain.handle('studio:forTitle', async (_evt, { tmdbId, mediaType }) => {
        try {
            const list = await studios.getTitleStudios(tmdbId, mediaType);
            return list.map((s) => ({ ...s, logo_url: s.logo_path ? `${studios.imgBase}w185${s.logo_path}` : null }));
        } catch (err) { console.error('studios:', err.message); return []; }
    });
    ipcMain.handle('studio:get', async (_evt, { kind, id }) => {
        const st = kind === 'publisher' ? await publishers.getPublisher(id)
            : (kind === 'developer' || kind === 'gpublisher') ? await rawg.getCompany(kind, id)
            : await studios.getStudio(kind, id);
        const session = await sb.getSession();
        let statusMap = {};
        if (session) { try { statusMap = await sb.getStatusesForItems(session, st.credits); } catch (err) { console.error(err); } }
        return {
            ...st,
            logo_url: st.logo_path ? (/^https?:/.test(st.logo_path) ? st.logo_path : `${studios.imgBase}w500${st.logo_path}`) : null,
            credits: st.credits.map((c) => ({ ...c, poster_url: tmdb.imageUrl(c.poster_path, 'w500'), status: statusMap[`${c.media_type}:${c.tmdb_id}`] || null })),
        };
    });
    ipcMain.handle('studio:follow', async (_evt, a) => sb.followStudio(await sb.getSession(), a));
    ipcMain.handle('studio:unfollow', async (_evt, a) => sb.unfollowStudio(await sb.getSession(), a));
    ipcMain.handle('studio:isFollowing', async (_evt, a) => sb.isFollowingStudio(await sb.getSession(), a));
    ipcMain.handle('studio:listFollowed', async () => { const s = await sb.getSession(); return s ? sb.listFollowedStudios(s) : []; });

    // ---- episodes (TV progress) ----
    ipcMain.handle('episodes:getSeason', async (_evt, { mediaId, tmdbId, seasonNumber }) => {
        let episodes = await sb.getEpisodes(mediaId, seasonNumber);
        if (episodes.length === 0) {
            const fetched = await tmdb.getTvSeasonEpisodes(tmdbId, seasonNumber);
            await sb.upsertEpisodes(mediaId, fetched);
            episodes = await sb.getEpisodes(mediaId, seasonNumber);
        }
        return episodes;
    });

    ipcMain.handle('episodes:toggleWatched', async (_evt, { entryId, episodeId, watched }) => {
        const session = await sb.getSession();
        return sb.toggleWatchedEpisode(session, entryId, episodeId, watched);
    });

    ipcMain.handle('episodes:getWatched', async (_evt, { entryId }) => {
        const session = await sb.getSession();
        return sb.getWatchedEpisodeIds(session, entryId);
    });

    ipcMain.handle('episodes:getLastWatchedSeason', async (_evt, { entryId }) => {
        const session = await sb.getSession();
        if (!session) return null;
        try {
            return await sb.getLastWatchedSeason(session, entryId);
        } catch (err) {
            console.error('Failed to look up last watched season:', err);
            return null;
        }
    });

    // Background check, run once on app launch (see renderer.js). Covers
    // every TV show that's either completed (might need auto-reverting to
    // Watching) or already in_progress (Continue Watching — still needs its
    // cached episode count / season art refreshed, or it just goes stale
    // until the user happens to reopen that specific show).
    ipcMain.handle('app:checkForNewEpisodes', async () => {
        const session = await sb.getSession();
        if (!session) return [];

        let shows;
        try {
            shows = await sb.listTrackedTvEntries(session);
        } catch (err) {
            console.error('Failed to list tracked TV shows:', err);
            return [];
        }

        // Capped concurrency instead of firing every show's TMDB request at
        // once — with a large tracked-shows list this was competing with
        // whatever the user clicks right after launch for the same
        // connection pool, which is what made things feel slow right when
        // the app opens. Runs a handful at a time instead; the background
        // check itself takes a little longer in wall-clock time, but that's
        // invisible since nothing in the UI waits on it.
        const CONCURRENCY = 5;
        const updated = [];
        let cursor = 0;
        async function worker() {
            for (;;) {
                const i = cursor++;
                if (i >= shows.length) return;
                const show = shows[i];
                try {
                    const [counts, watchedIds] = await Promise.all([
                        tmdb.getTvEpisodeCount(show.tmdbId),
                        sb.getWatchedEpisodeIds(session, show.entryId),
                    ]);
                    // Refresh the cache for every tracked show, regardless of
                    // status — this is what the Continue Watching card's episode
                    // count and season poster are built from.
                    await Promise.all([
                        sb.updateMediaEpisodeCounts(show.mediaId, counts),
                        sb.upsertSeasonMeta(show.mediaId, counts.seasons),
                    ]);

                    const liveCount = counts.number_of_episodes;
                    if (show.status === 'completed' && liveCount != null && watchedIds.length < liveCount) {
                        await sb.upsertEntry(session, show.mediaId, { status: 'in_progress' });
                        updated.push({ title: show.title, newEpisodeCount: liveCount - watchedIds.length });
                    }
                } catch (err) {
                    console.error(`Failed to check new episodes for "${show.title}":`, err);
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shows.length) }, worker));
        return updated;
    });

    ipcMain.handle('app:showNotification', (_evt, { title, body }) => {
        if (!Notification.isSupported()) return { shown: false };
        new Notification({ title, body }).show();
        return { shown: true };
    });
}

module.exports = { registerHandlers };
