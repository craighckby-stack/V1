import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';

interface ImageEditConfig {
	imageSource: string;
	prompt: string;
	size: '1024x1024' | '768x1344' | '864x1152' | '1344x768' | '1152x864' | '1440x720' | '720x1440';
	outFile: string;
}

interface ImageEditResponse {
	data?: Array<{
		base64?: string;
	}>;
}

async function editImage(config: ImageEditConfig): Promise<void> {
	try {
		const zai = await ZAI.create();

		const response = await zai.images.generations.edit({
			prompt: config.prompt,
			images: [{ url: config.imageSource }],
			size: config.size
		}) as ImageEditResponse;

		const base64 = response?.data?.[0]?.base64;
		if (!base64) {
			console.error('No image data returned by the API');
			console.log('Full response:', JSON.stringify(response, null, 2));
			return;
		}

		const buffer = Buffer.from(base64, 'base64');
		fs.writeFileSync(config.outFile, buffer);
		console.log(`Edited image saved to ${config.outFile}`);
	} catch (err: any) {
		console.error('Image editing failed:', err?.message || err);
	}
}

async function main(imageSource: string, prompt: string, size: '1024x1024' | '768x1344' | '864x1152' | '1344x768' | '1152x864' | '1440x720' | '720x1440', outFile: string) {
	const config: ImageEditConfig = {
		imageSource,
		prompt,
		size,
		outFile
	};
	await editImage(config);
}

// Example usage - Edit an image
// You can use either a URL or a base64 data URL for the imageSource
main(
	'https://example.com/photo.jpg',  // or use: 'data:image/jpeg;base64,/9j/4AAQ...'
	'Transform this photo to have a sunset background with warm golden tones',
	'1024x1024',
	'./output.png'
);