/*
 * User-selected download directory storage.
 * Handles are stored in a separate IndexedDB database, independent of media caches.
 */
/*! ESLINT IMPORT END !*/

const DOWNLOAD_DIRECTORY_DB = 'IG_HELPER_DOWNLOAD_DIRECTORY';
const DOWNLOAD_DIRECTORY_STORE = 'HANDLES';
const DOWNLOAD_DIRECTORY_KEY = 'root';
const INVALID_PATH_CHARS = /[<>:"\/\\|?*\u0000-\u001F]/g;
let downloadDirectoryDBPromise = null;
let downloadDirectoryHandle = null;
let downloadDirectoryInitPromise = null;
let directoryPickerPromise = null;
const reservedDownloadPaths = new Set();

function openDownloadDirectoryDB() {
    if (downloadDirectoryDBPromise) return downloadDirectoryDBPromise;
    downloadDirectoryDBPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DOWNLOAD_DIRECTORY_DB, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(DOWNLOAD_DIRECTORY_STORE)) {
                request.result.createObjectStore(DOWNLOAD_DIRECTORY_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Download directory database is blocked'));
    }).catch(err => {
        downloadDirectoryDBPromise = null;
        throw err;
    });
    return downloadDirectoryDBPromise;
}

function readStoredDownloadDirectory() {
    return openDownloadDirectoryDB().then(db => new Promise((resolve, reject) => {
        const request = db.transaction(DOWNLOAD_DIRECTORY_STORE, 'readonly')
            .objectStore(DOWNLOAD_DIRECTORY_STORE).get(DOWNLOAD_DIRECTORY_KEY);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
    }));
}

function storeDownloadDirectory(handle) {
    return openDownloadDirectoryDB().then(db => new Promise((resolve, reject) => {
        const transaction = db.transaction(DOWNLOAD_DIRECTORY_STORE, 'readwrite');
        transaction.objectStore(DOWNLOAD_DIRECTORY_STORE).put(handle, DOWNLOAD_DIRECTORY_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Download directory save aborted'));
    }));
}

export function initDownloadDirectory() {
    if (!downloadDirectoryInitPromise) {
        downloadDirectoryInitPromise = readStoredDownloadDirectory()
            .then(handle => {
                if (!downloadDirectoryHandle && handle) downloadDirectoryHandle = handle;
                return downloadDirectoryHandle;
            })
            .catch(err => {
                console.warn('Unable to restore the selected download folder:', err);
                return null;
            });
    }
    return downloadDirectoryInitPromise;
}

export function isDirectoryPickerSupported() {
    return typeof window.showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined';
}

export async function getDownloadDirectoryName() {
    await initDownloadDirectory();
    return downloadDirectoryHandle?.name ?? null;
}

export async function selectDownloadDirectory() {
    if (!isDirectoryPickerSupported()) throw new Error('The File System Access API is not supported in this browser.');
    // Invoke the picker before awaiting anything so the settings-button gesture is retained.
    const handle = await window.showDirectoryPicker({ id: 'ig-helper-download-folder', mode: 'readwrite' });
    if (typeof handle.requestPermission === 'function') {
        const permission = await handle.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') throw new Error('Write permission was not granted.');
    }
    downloadDirectoryHandle = handle;
    await storeDownloadDirectory(handle);
    return handle.name;
}

export async function clearDownloadDirectory() {
    downloadDirectoryHandle = null;
    const db = await openDownloadDirectoryDB();
    await new Promise((resolve, reject) => {
        const transaction = db.transaction(DOWNLOAD_DIRECTORY_STORE, 'readwrite');
        transaction.objectStore(DOWNLOAD_DIRECTORY_STORE).delete(DOWNLOAD_DIRECTORY_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Download directory removal aborted'));
    });
}

function requestDirectoryWritePermission(handle) {
    try {
        if (typeof handle.requestPermission === 'function') return handle.requestPermission({ mode: 'readwrite' });
        if (typeof handle.queryPermission === 'function') return handle.queryPermission({ mode: 'readwrite' });
        return Promise.resolve('granted');
    }
    catch (err) {
        return Promise.reject(err);
    }
}

export function getDirectoryHandleForSave() {
    if (downloadDirectoryHandle) {
        const handle = downloadDirectoryHandle;
        return requestDirectoryWritePermission(handle)
            .then(permission => permission === 'granted' ? { handle } : { fallback: true })
            .catch(() => ({ fallback: true }));
    }
    if (!isDirectoryPickerSupported()) return Promise.resolve({ fallback: true });
    if (directoryPickerPromise) return directoryPickerPromise;

    // This call must remain synchronous with the initiating download click.
    let picker;
    try {
        picker = window.showDirectoryPicker({ id: 'ig-helper-download-folder', mode: 'readwrite' });
    }
    catch (err) {
        return Promise.resolve({ fallback: true });
    }
    directoryPickerPromise = Promise.resolve(picker)
        .then(async handle => {
            if (typeof handle.requestPermission === 'function') {
                const permission = await handle.requestPermission({ mode: 'readwrite' });
                if (permission !== 'granted') return { fallback: true };
            }
            downloadDirectoryHandle = handle;
            await storeDownloadDirectory(handle);
            return { handle };
        })
        .catch(err => err?.name === 'AbortError' ? { cancelled: true } : { fallback: true })
        .finally(() => { directoryPickerPromise = null; });
    return directoryPickerPromise;
}

function sanitizePathSegment(value, fallback) {
    let result = String(value ?? '')
        .replace(INVALID_PATH_CHARS, '_')
        .replace(/[. ]+$/g, '')
        .trim();
    if (!result || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(result)) result = fallback;
    return result;
}

async function fileExists(directoryHandle, filename) {
    try {
        await directoryHandle.getFileHandle(filename);
        return true;
    }
    catch (err) {
        if (err?.name === 'NotFoundError') return false;
        throw err;
    }
}

function addCollisionSuffix(filename, index) {
    const dot = filename.lastIndexOf('.');
    if (dot > 0) return filename.slice(0, dot) + ' (' + index + ')' + filename.slice(dot);
    return filename + ' (' + index + ')';
}

export async function writeBlobToDirectory(blob, filename, username, rootHandle, overwriteExisting = false) {
    const userFolderName = sanitizePathSegment(username, 'unknown_user');
    const safeFilename = sanitizePathSegment(filename, 'download');
    const userDirectory = await rootHandle.getDirectoryHandle(userFolderName, { create: true });
    let candidate = safeFilename;
    let index = 1;
    let reservation = '';

    if (overwriteExisting) {
        reservation = userFolderName + '/' + candidate;
        while (reservedDownloadPaths.has(reservation)) {
            candidate = addCollisionSuffix(safeFilename, index++);
            reservation = userFolderName + '/' + candidate;
        }
    }
    else {
        while (true) {
            reservation = userFolderName + '/' + candidate;
            if (!reservedDownloadPaths.has(reservation)) {
                const exists = await fileExists(userDirectory, candidate);
                if (!exists && !reservedDownloadPaths.has(reservation)) break;
            }
            candidate = addCollisionSuffix(safeFilename, index++);
        }
    }

    reservedDownloadPaths.add(reservation);
    try {
        const fileHandle = await userDirectory.getFileHandle(candidate, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return candidate;
    }
    finally {
        reservedDownloadPaths.delete(reservation);
    }
}

void initDownloadDirectory();
