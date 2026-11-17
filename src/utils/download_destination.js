/*! ESLINT IMPORT END !*/

const DB_NAME = 'IG_HELPER_DOWNLOAD_DESTINATION';
const DB_VERSION = 1;
const STORE_NAME = 'DESTINATION';
const HANDLE_KEY = 'directoryHandle';

function openDestinationDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Download destination database is blocked'));
    });
}

async function storeDirectoryHandle(handle) {
    const db = await openDestinationDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Saving folder handle was aborted'));
        });
    } finally {
        db.close();
    }
}

export async function getDownloadDirectoryHandle() {
    const db = await openDestinationDB();
    try {
        return await new Promise((resolve, reject) => {
            const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(HANDLE_KEY);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

export async function selectDownloadDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('このブラウザはフォルダ選択に対応していません。');
    }

    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
        throw new Error('選択したフォルダへの書き込みが許可されませんでした。');
    }

    await storeDirectoryHandle(handle);
    return handle;
}

export async function getDownloadDirectoryName() {
    const handle = await getDownloadDirectoryHandle();
    return handle?.name || '';
}

function normalizeRelativePath(filename) {
    const segments = String(filename).replace(/\\/g, '/').split('/')
        .filter(segment => segment && segment !== '.' && segment !== '..');
    if (!segments.length) {
        throw new Error('保存するファイル名が空です。');
    }
    return segments;
}

export async function writeBlobToDownloadDirectory(blob, filename) {
    const handle = await getDownloadDirectoryHandle();
    if (!handle) {
        throw new Error('保存先フォルダが選択されていません。設定画面からフォルダを選択してください。');
    }

    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
        throw new Error('保存先フォルダへのアクセス権がありません。設定画面からフォルダを選択し直してください。');
    }

    const segments = normalizeRelativePath(filename);
    let directory = handle;
    for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment, { create: true });
    }

    const fileHandle = await directory.getFileHandle(segments[segments.length - 1], { create: true });
    const writable = await fileHandle.createWritable();
    try {
        await writable.write(blob);
        await writable.close();
    } catch (error) {
        try { await writable.abort(); } catch { /* best effort */ }
        throw error;
    }
}
