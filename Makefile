UUID := jira-sprint@charles.local
BUILD := build
BUNDLE := $(BUILD)/$(UUID).shell-extension.zip

.PHONY: test pack install uninstall sync dev e2e

test:
	python3 -m unittest discover -s tests -v
	glib-compile-schemas --strict --dry-run extension/schemas

# Drives the real UI with a virtual pointer and keyboard in a headless shell.
e2e:
	tests/e2e.sh

pack:
	mkdir -p $(BUILD)
	gnome-extensions pack extension --force --out-dir $(BUILD) \
		--extra-source=lib --extra-source=helper

# A running Wayland shell only discovers new extensions at login, so the
# first install is pre-enabled through gsettings and needs a re-login.
# Later installs also need one to load changed code.
install: pack
	gnome-extensions install --force $(BUNDLE)
	@gnome-extensions enable $(UUID) 2>/dev/null || python3 -c "from gi.repository import Gio; \
s = Gio.Settings.new('org.gnome.shell'); e = s.get_strv('enabled-extensions'); \
'$(UUID)' in e or s.set_strv('enabled-extensions', e + ['$(UUID)']); Gio.Settings.sync()"
	@echo "Installed. Log out and back in to load it."

# Edit-run loop without logging out: a throwaway nested shell in a window,
# which loads the freshly installed code every time it starts.
dev: install
	dbus-run-session gnome-shell --devkit

uninstall:
	gnome-extensions uninstall $(UUID)
