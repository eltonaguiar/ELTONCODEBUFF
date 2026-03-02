import fs from 'fs';
import path from 'path';

const IGNORED_DIRS = new Set([
    'node_modules', '.git', '.next', '.nuxt', 'dist', 'build',
    '__pycache__', '.venv', 'venv', '.idea', '.vscode',
    'coverage', '.cache', 'tmp', '.tmp',
]);

const TEXT_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.pyw',
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.json', '.jsonc', '.json5',
    '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.md', '.mdx', '.txt', '.csv', '.tsv',
    '.sql', '.graphql', '.gql',
    '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1',
    '.rs', '.go', '.java', '.kt', '.kts', '.scala',
    '.c', '.h', '.cpp', '.hpp', '.cc',
    '.cs', '.fs', '.fsx',
    '.rb', '.rake', '.gemspec',
    '.php', '.phtml',
    '.swift', '.m', '.mm',
    '.r', '.R',
    '.lua', '.vim', '.el',
    '.dockerfile', '.dockerignore',
    '.env', '.env.example', '.env.local',
    '.gitignore', '.gitattributes',
    '.eslintrc', '.prettierrc', '.babelrc',
    'Makefile', 'Dockerfile', 'Vagrantfile',
    'Gemfile', 'Rakefile', 'Procfile',
]);

export function setupFileRoutes(app) {
    // List directory tree
    app.post('/api/files/tree', (req, res) => {
        const { dirPath } = req.body;
        if (!dirPath) {
            return res.status(400).json({ error: 'dirPath is required' });
        }

        try {
            const resolved = path.resolve(dirPath);
            if (!fs.existsSync(resolved)) {
                return res.status(404).json({ error: 'Directory not found' });
            }
            const tree = buildTree(resolved, 0, 3);
            res.json({ tree, root: resolved });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Read a file
    app.post('/api/files/read', (req, res) => {
        const { filePath } = req.body;
        if (!filePath) {
            return res.status(400).json({ error: 'filePath is required' });
        }

        try {
            const resolved = path.resolve(filePath);
            if (!fs.existsSync(resolved)) {
                return res.status(404).json({ error: 'File not found' });
            }
            const stat = fs.statSync(resolved);
            if (stat.size > 2 * 1024 * 1024) {
                return res.status(413).json({ error: 'File too large (>2MB)' });
            }
            const content = fs.readFileSync(resolved, 'utf-8');
            const ext = path.extname(resolved).toLowerCase();
            res.json({
                content,
                fileName: path.basename(resolved),
                extension: ext,
                size: stat.size,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Search files by content
    app.post('/api/files/search', (req, res) => {
        const { dirPath, query, maxResults = 50 } = req.body;
        if (!dirPath || !query) {
            return res.status(400).json({ error: 'dirPath and query are required' });
        }

        try {
            const resolved = path.resolve(dirPath);
            const results = searchFiles(resolved, query, maxResults);
            res.json({ results });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

function buildTree(dirPath, depth, maxDepth) {
    if (depth > maxDepth) return [];

    const items = [];
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') && depth === 0 && entry.name !== '.env.example') continue;
            if (IGNORED_DIRS.has(entry.name)) continue;

            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                items.push({
                    name: entry.name,
                    path: fullPath,
                    type: 'directory',
                    children: buildTree(fullPath, depth + 1, maxDepth),
                });
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                const isText = TEXT_EXTENSIONS.has(ext) || entry.name === 'Makefile' || entry.name === 'Dockerfile';
                try {
                    const stat = fs.statSync(fullPath);
                    items.push({
                        name: entry.name,
                        path: fullPath,
                        type: 'file',
                        extension: ext,
                        size: stat.size,
                        isText,
                    });
                } catch {
                    // Skip files we can't stat
                }
            }
        }
    } catch {
        // Skip directories we can't read
    }

    // Sort: directories first, then files alphabetically
    items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return items;
}

function searchFiles(dirPath, query, maxResults, results = []) {
    if (results.length >= maxResults) return results;

    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxResults) break;
            if (IGNORED_DIRS.has(entry.name)) continue;
            if (entry.name.startsWith('.')) continue;

            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                searchFiles(fullPath, query, maxResults, results);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (!TEXT_EXTENSIONS.has(ext)) continue;

                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > 500 * 1024) continue; // Skip large files

                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const lines = content.split('\n');
                    const queryLower = query.toLowerCase();

                    for (let i = 0; i < lines.length; i++) {
                        if (results.length >= maxResults) break;
                        if (lines[i].toLowerCase().includes(queryLower)) {
                            results.push({
                                file: fullPath,
                                line: i + 1,
                                content: lines[i].trim().substring(0, 200),
                            });
                        }
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        }
    } catch {
        // Skip unreadable directories
    }

    return results;
}
