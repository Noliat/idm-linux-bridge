package idm

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"github.com/google/uuid"
)

// ─────────────────────────────────────────────────────────────────────────────
// DASH Merge — baixar streams DASH separados e mergear com ffmpeg
// ─────────────────────────────────────────────────────────────────────────────

// dashMergeAndServe baixa streams DASH de vídeo e áudio separados e os mergeia
// com ffmpeg, retornando a URL local do arquivo resultante para o IDM.
//
// Usado quando a extensão envia streams DASH do YouTube (adaptiveFormats):
//   - videoURL: stream de vídeo sem áudio (ex: itag=137, 1080p h264)
//   - audioURL: stream de áudio sem vídeo (ex: itag=140, m4a 128k)
//
// Não requer yt-dlp — usa apenas ffmpeg + download direto.
func (l *Launcher) dashMergeAndServe(videoURL, audioURL string, job DownloadJob) string {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		log.Printf("[DASH] ffmpeg não encontrado — instale: apt install ffmpeg\n")
		return ""
	}

	// Resolver parâmetro 'n' nas duas URLs
	videoURL = l.resolveYouTubeN(videoURL, job.Referrer)
	audioURL = l.resolveYouTubeN(audioURL, job.Referrer)

	tmpDir, err := os.MkdirTemp("", "idm-dash-*")
	if err != nil {
		return ""
	}

	videoFile := filepath.Join(tmpDir, "video.tmp")
	audioFile := filepath.Join(tmpDir, "audio.tmp")
	outFile   := filepath.Join(tmpDir, "merged.mp4")

	type dlResult struct{ err error }
	videoCh := make(chan dlResult, 1)
	audioCh := make(chan dlResult, 1)

	go func() {
		err := l.downloadStreamToFile(videoURL, videoFile, job)
		videoCh <- dlResult{err}
	}()
	go func() {
		err := l.downloadStreamToFile(audioURL, audioFile, job)
		audioCh <- dlResult{err}
	}()

	log.Printf("[DASH] Baixando streams vídeo+áudio em paralelo...\n")
	timer := time.NewTimer(60 * time.Minute)
	defer timer.Stop()

	var vErr, aErr error
	for i := 0; i < 2; i++ {
		select {
		case r := <-videoCh: vErr = r.err
		case r := <-audioCh: aErr = r.err
		case <-timer.C:
			log.Printf("[DASH] Timeout aguardando streams\n")
			os.RemoveAll(tmpDir)
			return ""
		}
	}
	if vErr != nil { log.Printf("[DASH] Erro vídeo: %v\n", vErr); os.RemoveAll(tmpDir); return "" }
	if aErr != nil { log.Printf("[DASH] Erro áudio: %v\n", aErr); os.RemoveAll(tmpDir); return "" }

	// Merge com ffmpeg (cópia direta, sem re-encode)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, ffmpeg,
		"-y",
		"-i", videoFile,
		"-i", audioFile,
		"-c:v", "copy",
		"-c:a", "copy",
		"-movflags", "+faststart",
		"-f", "mp4",
		outFile,
	)
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		log.Printf("[DASH] ffmpeg falhou: %v\n", err)
		os.RemoveAll(tmpDir)
		return ""
	}

	os.Remove(videoFile)
	os.Remove(audioFile)

	token := "dash-" + uuid.New().String()[:8]
	filename := job.Filename
	if filename == "" { filename = "video.mp4" }
	if !strings.HasSuffix(strings.ToLower(filename), ".mp4") {
		filename = strings.TrimSuffix(filename, filepath.Ext(filename)) + ".mp4"
	}

	mergeJob := DownloadJob{
		URL:      "file://" + outFile,
		Filename: filename,
		Silent:   job.Silent,
	}
	l.mu.Lock()
	l.jobs[token] = &jobEntry{job: mergeJob, createdAt: time.Now()}
	l.mu.Unlock()

	go func() {
		time.Sleep(2 * time.Hour)
		os.RemoveAll(tmpDir)
		l.mu.Lock()
		delete(l.jobs, token)
		l.mu.Unlock()
	}()

	proxyURL := fmt.Sprintf("http://127.0.0.1:%d/%s", l.proxyPort, token)
	log.Printf("[DASH] ✓ Merge concluído → %s\n", proxyURL)
	return proxyURL
}

// downloadStreamToFile baixa um stream DASH para um arquivo local.
func (l *Launcher) downloadStreamToFile(streamURL, destPath string, job DownloadJob) error {
	req, err := http.NewRequest("GET", streamURL, nil)
	if err != nil { return fmt.Errorf("criar request: %w", err) }

	if job.Cookies != ""   { req.Header.Set("Cookie", job.Cookies) }
	if job.Referrer != ""  { req.Header.Set("Referer", job.Referrer) }
	ua := job.UserAgent
	if ua == "" { ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" }
	req.Header.Set("User-Agent",      ua)
	req.Header.Set("Accept",          "*/*")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Origin",          "https://www.youtube.com")
	req.Header.Set("Referer",         "https://www.youtube.com/")
	req.Header.Set("Sec-Fetch-Dest",  "empty")
	req.Header.Set("Sec-Fetch-Mode",  "cors")
	req.Header.Set("Sec-Fetch-Site",  "cross-site")

	client := &http.Client{Timeout: 60 * time.Minute}
	resp, err := client.Do(req)
	if err != nil { return fmt.Errorf("request: %w", err) }
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(destPath)
	if err != nil { return fmt.Errorf("criar arquivo: %w", err) }
	defer f.Close()

	buf := make([]byte, 256*1024)
	_, err = io.CopyBuffer(f, resp.Body, buf)
	return err
}

// resolveYouTubeN resolve apenas o parâmetro 'n' via goja (sem yt-dlp).
func (l *Launcher) resolveYouTubeN(rawURL, referrer string) string {
	if !strings.Contains(rawURL, "googlevideo.com") { return rawURL }
	resolved, err := ResolveNParam(rawURL, referrer)
	if err != nil || resolved == rawURL { return rawURL }
	return resolved
}
