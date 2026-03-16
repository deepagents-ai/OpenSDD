.PHONY: publish test

test:
	npm test

publish: test
	npm version patch
	npm publish
	git push && git push --tags
