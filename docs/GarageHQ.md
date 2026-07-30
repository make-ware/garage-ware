Goals and non-goals

Garage is a lightweight geo-distributed data store that implements the Amazon S3 object storage protocol. It enables applications to store large blobs such as pictures, video, images, documents, etc., in a redundant multi-node setting. S3 is versatile enough to also be used to publish a static website.
Garage is an opinionated object storage solution, we focus on the following desirable properties:
Internet enabled: made for multi-sites (eg. datacenters, offices, households, etc.) interconnected through regular Internet connections.
Self-contained & lightweight: works everywhere and integrates well in existing environments to target hyperconverged infrastructures.
Highly resilient: highly resilient to network failures, network latency, disk failures, sysadmin failures.
Simple: simple to understand, simple to operate, simple to debug.
We also noted that the pursuit of some other goals are detrimental to our initial goals. The following has been identified as non-goals (if these points matter to you, you should not use Garage):
Extreme performances: high performances constrain a lot the design and the infrastructure; we seek performances through minimalism only.
Feature extensiveness: we do not plan to add additional features compared to the ones provided by the S3 API.
Storage optimizations: erasure coding or any other coding technique both increase the difficulty of placing data and synchronizing; we limit ourselves to duplication.
POSIX/Filesystem compatibility: we do not aim at being POSIX compatible or to emulate any kind of filesystem. Indeed, in a distributed environment, such synchronizations are translated in network messages that impose severe constraints on the deployment.