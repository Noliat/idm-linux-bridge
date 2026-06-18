package idm

import (
	"fmt"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Funções auxiliares
// ─────────────────────────────────────────────────────────────────────────────

func isBinaryExtension(ext string) bool {
	binaryExts := map[string]bool{
		".iso": true, ".img": true, ".bin": true,
		".zip": true, ".rar": true, ".7z":  true, ".tar": true,
		".gz":  true, ".bz2": true, ".xz":  true, ".zst": true,
		".mp4": true, ".mkv": true, ".avi": true, ".mov": true,
		".wmv": true, ".flv": true, ".webm": true, ".m4v": true,
		".mp3": true, ".flac": true, ".wav": true, ".aac": true,
		".ogg": true, ".m4a": true, ".opus": true,
		".exe": true, ".msi": true, ".deb": true, ".rpm": true,
		".apk": true, ".dmg": true, ".pkg": true,
		".pdf": true, ".docx": true, ".xlsx": true, ".pptx": true,
		".torrent": true,
	}
	return binaryExts[ext]
}

func mimeByExtension(filename string) string {
	ext := strings.ToLower(fileExtension(filename))
	mimes := map[string]string{
		".mp4": "video/mp4", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
		".mov": "video/quicktime", ".wmv": "video/x-ms-wmv", ".webm": "video/webm",
		".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
		".aac": "audio/aac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
		".zip": "application/zip", ".rar": "application/x-rar-compressed",
		".7z":  "application/x-7z-compressed", ".tar": "application/x-tar",
		".gz":  "application/gzip", ".bz2": "application/x-bzip2",
		".pdf": "application/pdf",
		".exe": "application/x-msdownload", ".msi": "application/x-msi",
		".deb": "application/vnd.debian.binary-package", ".rpm": "application/x-rpm",
		".apk": "application/vnd.android.package-archive",
		".iso": "application/x-iso9660-image",
		".torrent": "application/x-bittorrent",
	}
	if m, ok := mimes[ext]; ok {
		return m
	}
	return "application/octet-stream"
}

func filenameFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	parts := strings.Split(u.Path, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			name, _ := url.PathUnescape(parts[i])
			return strings.SplitN(name, "?", 2)[0]
		}
	}
	return ""
}

func fileExtension(filename string) string {
	base := filepath.Base(filename)
	if strings.HasPrefix(base, ".") && strings.Count(base, ".") == 1 {
		return ""
	}
	idx := strings.LastIndex(base, ".")
	if idx <= 0 {
		return ""
	}
	return base[idx:]
}

func sanitizeFilename(name string) string {
	r := strings.NewReplacer(`"`, "", `\`, "", `/`, "", `:`, "", `*`, "", `?`, "", `<`, "", `>`, "", `|`, "")
	name = r.Replace(strings.TrimSpace(name))
	if len(name) > 200 {
		ext := fileExtension(name)
		name = name[:200-len(ext)] + ext
	}
	return name
}

func findWine() (string, error) {
	candidates := []string{"wine", "wine64", "/usr/bin/wine", "/usr/local/bin/wine"}
	for _, c := range candidates {
		if path, err := exec.LookPath(c); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("wine não encontrado. Instale com: sudo apt install wine")
}
