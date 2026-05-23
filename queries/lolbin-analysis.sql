-- ============================================================================
-- LOLBin Analysis Queries for manpage-db
-- Usage: sqlite3 db/manpages.db < queries/lolbin-analysis.sql
--    or: manpage-db sql "$(cat queries/lolbin-analysis.sql)"
-- ============================================================================

-- Uncomment headers for human-readable output in sqlite3 CLI:
-- .mode column
-- .headers on
-- .width 20 60

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. OVERVIEW: Database stats
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== DATABASE OVERVIEW ===' AS section;

SELECT
  (SELECT COUNT(*) FROM commands)  AS total_commands,
  (SELECT COUNT(*) FROM switches)  AS total_switches,
  (SELECT COUNT(*) FROM examples)  AS total_examples,
  (SELECT COUNT(*) FROM params)    AS total_params;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. MULTI-CATEGORY LOLBins: binaries that span 3+ threat categories
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== HIGH-RISK: 3+ CATEGORIES ===' AS section;

SELECT name, categories,
  length(categories) - length(replace(categories, ',', '')) + 1 AS category_count
FROM lolbin_summary
WHERE length(categories) - length(replace(categories, ',', '')) + 1 >= 3
ORDER BY category_count DESC, name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. NETWORK + EXEC: binaries that can reach the network AND execute commands
--    (highest C2 / reverse shell risk)
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== NETWORK + EXEC (C2 RISK) ===' AS section;

SELECT name, categories
FROM lolbin_summary
WHERE categories LIKE '%network%'
  AND categories LIKE '%exec%'
ORDER BY name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. NETWORK + FILE-COPY: data exfiltration candidates
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== NETWORK + FILE-COPY (EXFIL RISK) ===' AS section;

SELECT name, categories
FROM lolbin_summary
WHERE categories LIKE '%network%'
  AND categories LIKE '%file-copy%'
ORDER BY name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. DOWNLOAD CAPABLE: binaries that can fetch from URLs / remote
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== DOWNLOAD CAPABLE ===' AS section;

SELECT DISTINCT c.name, c.description
FROM commands c
WHERE c.description LIKE '%download%'
   OR c.description LIKE '%transfer%'
   OR c.description LIKE '%fetch%'
   OR c.name IN ('curl','wget','ftp','sftp','scp','rsync','aria2c','fetch')
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. REVERSE SHELL CANDIDATES: binaries with exec + network/socket refs
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== REVERSE SHELL CANDIDATES ===' AS section;

SELECT DISTINCT c.name, c.description
FROM commands c
JOIN switches s ON s.command = c.name
WHERE (
    s.description LIKE '%exec%'
    OR s.description LIKE '%shell%'
    OR s.description LIKE '%command%'
    OR s.long = '--exec'
  )
  AND c.name IN (
    SELECT DISTINCT c2.name
    FROM commands c2
    JOIN switches s2 ON s2.command = c2.name
    WHERE s2.description LIKE '%connect%'
       OR s2.description LIKE '%listen%'
       OR s2.description LIKE '%socket%'
       OR s2.description LIKE '%port%'
       OR c2.description LIKE '%TCP%'
       OR c2.description LIKE '%UDP%'
       OR c2.description LIKE '%socket%'
       OR c2.name IN ('nc','ncat','socat','ssh','telnet','openssl')
  )
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 7. FILE WRITE WITHOUT COPY: binaries that write arbitrary content to files
--    (useful for dropping payloads)
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== ARBITRARY FILE WRITE ===' AS section;

SELECT DISTINCT c.name, c.description
FROM commands c
JOIN switches s ON s.command = c.name
WHERE (
    s.short = '-o' OR s.long LIKE '--output%' OR s.long LIKE '--out%'
  )
  AND c.name NOT IN (SELECT name FROM lolbin_compile_interpret)
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 8. ENCODING / OBFUSCATION: binaries that encode/decode data
--    (payload obfuscation, data staging)
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== ENCODING / OBFUSCATION ===' AS section;

SELECT DISTINCT c.name, c.description
FROM commands c
WHERE c.description LIKE '%encode%'
   OR c.description LIKE '%decode%'
   OR c.description LIKE '%compress%'
   OR c.description LIKE '%encrypt%'
   OR c.name IN ('base64','base32','xxd','uuencode','uudecode','openssl','gpg','gzip','bzip2','xz')
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 9. SUID / PRIVILEGE ESCALATION: setuid binaries or permission changers
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== PRIVILEGE ESCALATION SURFACE ===' AS section;

SELECT DISTINCT c.name, c.description
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%setuid%'
   OR s.description LIKE '%suid%'
   OR s.description LIKE '%privilege%'
   OR s.description LIKE '%root%'
   OR s.description LIKE '%effective uid%'
   OR c.description LIKE '%super-user%'
   OR c.description LIKE '%superuser%'
   OR c.name IN ('sudo','su','doas','pkexec','chroot','newgrp','sg')
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 10. INTERPRETERS & SCRIPT ENGINES: code execution without compilers
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== INTERPRETERS / SCRIPT ENGINES ===' AS section;

SELECT c.name, c.description
FROM commands c
WHERE c.description LIKE '%interpreter%'
   OR c.description LIKE '%scripting%'
   OR c.description LIKE '%shell%'
   OR c.description LIKE '%evaluate%expression%'
   OR c.name IN (
     'python','python3','perl','ruby','node','lua','luajit',
     'awk','gawk','mawk','sed','gsed',
     'bash','sh','zsh','dash','csh','tcsh','ksh',
     'tclsh','expect','php','wish','bc','dc'
   )
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 11. PROCESS INJECTION / LIBRARY LOADING: LD_PRELOAD, dylib, dlopen refs
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== LIBRARY LOADING / INJECTION ===' AS section;

SELECT DISTINCT c.name, s.short, s.long, s.description
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%preload%'
   OR s.description LIKE '%dlopen%'
   OR s.description LIKE '%dylib%'
   OR s.description LIKE '%shared librar%'
   OR s.description LIKE '%load.*librar%'
   OR s.description LIKE '%plugin%'
   OR s.long LIKE '--library%'
   OR s.long LIKE '--plugin%'
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 12. CREDENTIAL ACCESS: binaries referencing passwords, keys, tokens
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== CREDENTIAL ACCESS ===' AS section;

SELECT DISTINCT c.name, s.short, s.long,
  substr(s.description, 1, 100) AS switch_desc_preview
FROM commands c
JOIN switches s ON s.command = c.name
WHERE s.description LIKE '%password%'
   OR s.description LIKE '%credential%'
   OR s.description LIKE '%passphrase%'
   OR s.description LIKE '%secret%key%'
   OR s.description LIKE '%auth.*token%'
   OR s.description LIKE '%private key%'
   OR s.long LIKE '%password%'
   OR s.long LIKE '%token%'
   OR s.long LIKE '%credential%'
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 13. DISCOVERY / RECON: binaries for system and network enumeration
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== DISCOVERY / RECON ===' AS section;

SELECT c.name, c.description
FROM commands c
WHERE c.description LIKE '%display%process%'
   OR c.description LIKE '%list%file%'
   OR c.description LIKE '%system information%'
   OR c.description LIKE '%enumerate%'
   OR c.description LIKE '%scan%'
   OR c.description LIKE '%network status%'
   OR c.description LIKE '%routing table%'
   OR c.name IN (
     'ps','top','htop','lsof','netstat','ss','who','w','id','groups',
     'uname','hostname','ifconfig','ip','arp','route','df','mount',
     'lsblk','lspci','lsusb','dmidecode','sysctl','dmesg','last',
     'finger','nmap','find','locate','mdfind','which','whereis','file'
   )
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 14. PERSISTENCE: cron, launch, startup references
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== PERSISTENCE MECHANISMS ===' AS section;

SELECT DISTINCT c.name, c.description
FROM commands c
WHERE c.description LIKE '%schedule%'
   OR c.description LIKE '%cron%'
   OR c.description LIKE '%periodic%'
   OR c.description LIKE '%launch%agent%'
   OR c.description LIKE '%launch%daemon%'
   OR c.description LIKE '%startup%'
   OR c.description LIKE '%boot%'
   OR c.name IN ('crontab','at','batch','launchctl','pmset','login','systemd')
ORDER BY c.name;

-- ──────────────────────────────────────────────────────────────────────────────
-- 15. FTS SEARCH: full-text search examples across switch descriptions
--     (edit the MATCH term to search for anything)
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== FTS: switches mentioning "execute" ===' AS section;

SELECT command, short, long, description
FROM switches_fts
WHERE switches_fts MATCH 'execute'
LIMIT 30;

-- ──────────────────────────────────────────────────────────────────────────────
-- 16. CHEATSHEET: most-switched commands (complexity = attack surface)
-- ──────────────────────────────────────────────────────────────────────────────

SELECT '=== TOP 30 MOST COMPLEX COMMANDS ===' AS section;

SELECT c.name, c.description, COUNT(s.id) AS switch_count
FROM commands c
JOIN switches s ON s.command = c.name
GROUP BY c.name
ORDER BY switch_count DESC
LIMIT 30;
