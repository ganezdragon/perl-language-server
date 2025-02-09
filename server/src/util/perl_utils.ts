const DEFAULT_PERL_GLOB_PATTERN = '**/*@(.pl|.pm|.t|.esp)';

function getGlobPattern(): string {
  const { GLOB_PATTERN } = process.env;
  
  return typeof GLOB_PATTERN === 'string'
    && GLOB_PATTERN.trim() !== ''
      ? GLOB_PATTERN
      : DEFAULT_PERL_GLOB_PATTERN;
}

export {
  getGlobPattern
}
