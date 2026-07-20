type AudioQueueEvent = 'stop' | 'empty-queue' | 'id-change';

interface AudioQueueStopDetail {
	event: AudioQueueEvent;
	id: string | null;
}

export type OnStoppedCallback = (detail: AudioQueueStopDetail) => void;

export class AudioQueue {
	private audio: HTMLAudioElement;
	private queue: string[] = [];
	private current: string | null = null;
	private readonly _onEnded = () => this.next();

	id: string | null = null;
	onStopped: OnStoppedCallback | null = null;

	constructor(audioElement: HTMLAudioElement) {
		this.audio = audioElement;
		this.audio.addEventListener('ended', this._onEnded);
	}

	setId(newId: string) {
		if (this.id === newId) return;

		this.#halt();
		this.id = newId;
		this.onStopped?.({ event: 'id-change', id: newId });
	}

	setPlaybackRate(rate: number) {
		this.audio.playbackRate = rate;
	}

	enqueue(url: string) {
		this.queue.push(url);

		// Auto-play if nothing is currently playing or loaded
		if (this.audio.paused && !this.current) {
			this.next();
		}
	}

	play() {
		if (!this.current && this.queue.length > 0) {
			this.next();
		} else {
			this.audio.play();
		}
	}

	next() {
		this.current = this.queue.shift() ?? null;

		if (this.current) {
			this.audio.src = this.current;
			this.audio.play();
		} else {
			this.#halt();
			this.onStopped?.({ event: 'empty-queue', id: this.id });
		}
	}

	stop() {
		this.#halt();
		this.onStopped?.({ event: 'stop', id: this.id });
	}

	destroy() {
		this.audio.removeEventListener('ended', this._onEnded);
		this.#halt();
		this.onStopped = null;
	}

	/**
	 * Pause audio and clear queue without firing onStopped.
	 * Callers that need the callback should invoke it themselves.
	 */
	#halt() {
		this.audio.pause();
		this.audio.currentTime = 0;
		this.audio.removeAttribute('src');
		this.audio.load();
		this.queue = [];
		this.current = null;
	}
}

/**
 * StreamingAudioPlayer - Plays streaming audio using MediaSource API
 * for real-time playback without waiting for complete file download
 */
export class StreamingAudioPlayer {
	private audio: HTMLAudioElement;
	private mediaSource: MediaSource | null = null;
	private sourceBuffer: SourceBuffer | null = null;
	private queue: Uint8Array[] = [];
	private isAppending = false;
	private isPlaying = false;
	private mimeType = 'audio/mpeg';

	constructor(audioElement: HTMLAudioElement) {
		this.audio = audioElement;
	}

	/**
	 * Initialize MediaSource for streaming playback
	 */
	async init(mimeType: string = 'audio/mpeg'): Promise<void> {
		this.mimeType = mimeType;
		
		if (!MediaSource.isTypeSupported(mimeType)) {
			throw new Error(`MediaSource does not support ${mimeType}`);
		}

		this.mediaSource = new MediaSource();
		this.audio.src = URL.createObjectURL(this.mediaSource);

		return new Promise((resolve, reject) => {
			if (!this.mediaSource) {
				reject(new Error('MediaSource not initialized'));
				return;
			}

			this.mediaSource.addEventListener('sourceopen', () => {
				try {
					this.sourceBuffer = this.mediaSource!.addSourceBuffer(mimeType);
					this.sourceBuffer.addEventListener('updateend', () => {
						this.isAppending = false;
						this.processQueue();
					});
					resolve();
				} catch (error) {
					reject(error);
				}
			});

			this.mediaSource.addEventListener('sourceerror', (error) => {
				reject(error);
			});
		});
	}

	/**
	 * Append audio chunk to the buffer
	 */
	appendChunk(chunk: Uint8Array): void {
		this.queue.push(chunk);
		this.processQueue();
	}

	/**
	 * Process the queue of audio chunks
	 */
	private processQueue(): void {
		if (this.isAppending || !this.sourceBuffer || this.queue.length === 0) {
			return;
		}

		this.isAppending = true;
		const chunk = this.queue.shift()!;

		try {
			// Convert Uint8Array to ArrayBuffer for SourceBuffer compatibility
			const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
			this.sourceBuffer.appendBuffer(arrayBuffer);
		} catch (error) {
			console.error('Error appending buffer:', error);
			this.isAppending = false;
		}
	}

	/**
	 * Start playback
	 */
	async play(): Promise<void> {
		if (!this.isPlaying) {
			await this.audio.play();
			this.isPlaying = true;
		}
	}

	/**
	 * Pause playback
	 */
	pause(): void {
		this.audio.pause();
		this.isPlaying = false;
	}

	/**
	 * End of stream - finalize the MediaSource
	 */
	endOfStream(): void {
		if (this.mediaSource && this.mediaSource.readyState === 'open') {
			// Wait for any pending updates and queue to be processed
			const tryEndOfStream = () => {
				if (!this.sourceBuffer) {
					try {
						this.mediaSource!.endOfStream();
					} catch (error) {
						console.error('Error ending stream:', error);
					}
					return;
				}

				// If SourceBuffer is updating, wait for it to finish
				if (this.sourceBuffer.updating || this.isAppending || this.queue.length > 0) {
					setTimeout(tryEndOfStream, 50);
					return;
				}

				// Safe to end stream now
				try {
					this.mediaSource!.endOfStream();
				} catch (error) {
					console.error('Error ending stream:', error);
				}
			};

			// Start the process
			tryEndOfStream();
		}
	}

	/**
	 * Stop playback and cleanup
	 */
	stop(): void {
		this.pause();
		this.audio.currentTime = 0;
		this.queue = [];
		this.isPlaying = false;

		if (this.mediaSource) {
			try {
				if (this.mediaSource.readyState === 'open') {
					// Wait for SourceBuffer to finish updating before ending stream
					const safeEndOfStream = () => {
						if (this.sourceBuffer && this.sourceBuffer.updating) {
							setTimeout(safeEndOfStream, 50);
							return;
						}
						try {
							if (this.mediaSource && this.mediaSource.readyState === 'open') {
								this.mediaSource.endOfStream();
							}
						} catch (error) {
							// Ignore errors during cleanup
						}
					};
					safeEndOfStream();
				}
			} catch (error) {
				// Ignore errors during cleanup
			}
		}

		// Reset appending flag after cleanup
		this.isAppending = false;

		this.audio.removeAttribute('src');
		this.audio.load();
		this.mediaSource = null;
		this.sourceBuffer = null;
	}

	/**
	 * Set playback rate
	 */
	setPlaybackRate(rate: number): void {
		this.audio.playbackRate = rate;
	}

	/**
	 * Check if currently playing
	 */
	getIsPlaying(): boolean {
		return this.isPlaying && !this.audio.paused;
	}
}

/**
 * Fetch and stream audio from a URL
 */
export async function streamAudioFromUrl(
	url: string,
	player: StreamingAudioPlayer,
	options?: {
		headers?: HeadersInit;
		signal?: AbortSignal;
	}
): Promise<void> {
	const response = await fetch(url, {
		headers: options?.headers,
		signal: options?.signal
	});

	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('Response body is not readable');
	}

	try {
		while (true) {
			const { done, value } = await reader.read();
			
			if (done) {
				player.endOfStream();
				break;
			}

			player.appendChunk(value);
			
			// Start playing as soon as we have some data
			if (!player.getIsPlaying()) {
				await player.play().catch(err => {
					console.log('Autoplay prevented, waiting for user interaction:', err);
				});
			}
		}
	} finally {
		reader.releaseLock();
	}
}
