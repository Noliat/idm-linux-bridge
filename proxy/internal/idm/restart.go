package idm

// main.go monitora este canal e chama os.Exit(2) quando recebe um sinal,
// deixando o systemd (ou wrapper script) reiniciar o processo com o
// ambiente gráfico correto (variáveis DISPLAY/WAYLAND_DISPLAY atualizadas).
func (l *Launcher) RestartCh() <-chan DisplayServer {
	return l.restartCh
}

// DisplayServerName retorna o nome legível do servidor gráfico atual.
func (l *Launcher) DisplayServerName() string {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.displayServer.String()
}
