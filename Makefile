.PHONY: driver extension install test-leds

driver:
	./scripts/install-driver.sh

extension:
	./scripts/install-extension.sh

install: driver extension

test-leds:
	./scripts/test-leds.sh
