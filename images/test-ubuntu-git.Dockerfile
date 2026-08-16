# Defines the test-ubuntu-git Container Image.
# Consumed by actions/checkout CI/CD validation workflows.

FROM ubuntu:26.04@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03

RUN apt update
RUN apt install -y git

LABEL org.opencontainers.image.title="Ubuntu + git (validation image)"
LABEL org.opencontainers.image.description="Ubuntu image with git pre-installed. Intended primarily for testing `actions/checkout` during CI/CD workflows."
LABEL org.opencontainers.image.documentation="https://github.com/actions/checkout/tree/main/images/test-ubuntu-git.md"
LABEL org.opencontainers.image.licenses=MIT
